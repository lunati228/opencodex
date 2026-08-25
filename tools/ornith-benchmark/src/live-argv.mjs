// Ornith-1.0-397B has 60 MoE layers. `--n-cpu-moe N` keeps the MoE weights of
// the first N layers on CPU, so layers N..59 retain their experts on GPU.
export const MODEL_MOE_LAYERS = 60;
export const MAX_CPU_MOE_SWEEP_LENGTH = 13;

// The sweep order is declared per campaign rather than hardcoded. Pinning one
// exact ascending list forced every attempt to open at n_cpu_moe=60, which
// places roughly 107 GB of experts host-side and leaves most VRAM unused - the
// worst reachable placement. The guard against silently reshaping a sweep to
// flatter numbers is preserved by validating the sweep's *properties* and by
// the existing hash-bound campaign declaration, not by a literal.
export function validateCpuMoeSweep(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_CPU_MOE_SWEEP_LENGTH
  ) {
    throw new Error("INVALID_CPU_MOE_SWEEP_LENGTH");
  }
  if (
    values.some(
      (value) =>
        !Number.isInteger(value) || value < 0 || value > MODEL_MOE_LAYERS,
    )
  ) {
    throw new Error("INVALID_CPU_MOE_SWEEP_VALUE");
  }
  // Strictly descending: each step moves one more expert layer onto the GPUs,
  // so the ladder stays monotonic and successive candidates stay comparable.
  if (values.some((value, index) => index > 0 && value >= values[index - 1])) {
    throw new Error("INVALID_CPU_MOE_SWEEP_ORDER");
  }
  return [...values];
}

// Retained for callers that want the original protocol ladder explicitly.
export const CPU_MOE_SWEEP = Object.freeze([60, 58, 56, 54, 52, 50, 48]);

function text(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`INVALID_ARGV_VALUE: ${name}`);
  }
  return value;
}

function integer(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`INVALID_ARGV_INTEGER: ${name}`);
  }
  return String(value);
}

function priority(value) {
  if (!Number.isInteger(value) || value < -1 || value > 3) {
    throw new Error("INVALID_ARGV_INTEGER: priority");
  }
  return String(value);
}

function binary(value) {
  return value ? "1" : "0";
}

function loadFlags(loadMode, target) {
  const mapping = {
    mmap: target === "bench" ? ["-mmp", "1", "-dio", "0"] : ["--mmap", "--no-direct-io"],
    dio: target === "bench" ? ["-mmp", "0", "-dio", "1"] : ["--no-mmap", "--direct-io"],
    none: target === "bench" ? ["-mmp", "0", "-dio", "0"] : ["--no-mmap", "--no-direct-io"],
  };
  if (!mapping[loadMode]) throw new Error("INVALID_LOAD_MODE");
  return mapping[loadMode];
}

// `--n-cpu-moe N` keeps the first N layers' experts on CPU, so layers N..59
// retain theirs on GPU. Under `-sm layer` that expert-bearing tail lands
// entirely on the last device, which is the documented 25.7 GiB OOM unless the
// split matches. The two settings are one decision, so "coordinated" derives
// the split from the candidate's own n_cpu_moe and they can never drift apart
// as the sweep advances.
export function coordinatedTensorSplit(nCpuMoe) {
  if (
    !Number.isInteger(nCpuMoe) ||
    nCpuMoe < 0 ||
    nCpuMoe > MODEL_MOE_LAYERS
  ) {
    throw new Error("INVALID_ARGV_INTEGER: n_cpu_moe");
  }
  return [nCpuMoe, MODEL_MOE_LAYERS - nCpuMoe];
}

function tensorSplit(candidate, separator) {
  if (candidate.tensor_split === "auto") return null;
  if (candidate.tensor_split === "coordinated") {
    if (candidate.backend_devices?.length !== 2) {
      throw new Error("COORDINATED_TENSOR_SPLIT_REQUIRES_TWO_DEVICES");
    }
    return coordinatedTensorSplit(candidate.n_cpu_moe).join(separator);
  }
  if (
    !Array.isArray(candidate.tensor_split) ||
    candidate.tensor_split.length !== candidate.backend_devices.length ||
    candidate.tensor_split.some((value) =>
      !(
        (typeof value === "string" && value.length > 0) ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0)
      ))
  ) {
    throw new Error("INVALID_TENSOR_SPLIT");
  }
  return candidate.tensor_split.map(String).join(separator);
}

function backendDeviceList(candidate, separator) {
  if (
    !Array.isArray(candidate.backend_devices) ||
    ![1, 2].includes(candidate.backend_devices.length) ||
    candidate.backend_devices.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error("INVALID_BACKEND_DEVICES");
  }
  return candidate.backend_devices.join(separator);
}

export function buildBenchCommonArgs({ model, candidate }) {
  const args = [
    "-m", text(model, "model"),
    "-b", integer(candidate.batch, "batch"),
    "-ub", integer(candidate.ubatch, "ubatch"),
    "-t", integer(candidate.threads, "threads"),
    "--cpu-mask", text(candidate.cpu_mask, "cpu_mask"),
    "--cpu-strict", binary(candidate.cpu_strict),
    "--prio", priority(candidate.priority),
    "--poll", integer(candidate.poll, "poll"),
    "-ngl", integer(candidate.n_gpu_layers, "n_gpu_layers"),
    "-ncmoe", integer(candidate.n_cpu_moe, "n_cpu_moe"),
    "-ctk", text(candidate.cache_type_k, "cache_type_k"),
    "-ctv", text(candidate.cache_type_v, "cache_type_v"),
    "-fa", text(candidate.flash_attn, "flash_attn"),
    "-sm", text(candidate.split_mode, "split_mode"),
    "-dev", backendDeviceList(candidate, "/"),
    ...loadFlags(candidate.load_mode, "bench"),
    "-nkvo", candidate.kv_offload ? "0" : "1",
    "-nopo", candidate.op_offload ? "0" : "1",
  ];
  const split = tensorSplit(candidate, "/");
  if (split) args.push("-ts", split);
  args.push("-o", "json");
  return args;
}

const BENCH_KINDS = Object.freeze({
  short: [
    ["pp2k", ["-p", "2048", "-n", "0", "-d", "0", "-r", "3"], 3],
    ["tg256-d2k", ["-p", "0", "-n", "256", "-d", "2048", "-r", "3"], 3],
  ],
  final: [
    ["pp8k", ["-p", "8192", "-n", "0", "-d", "0", "-r", "5"], 5],
    ["tg1024-d8k", ["-p", "0", "-n", "1024", "-d", "8192", "-r", "5"], 5],
    ["pp16k", ["-p", "16384", "-n", "0", "-d", "0", "-r", "3"], 3],
    ["tg1024-d16k", ["-p", "0", "-n", "1024", "-d", "16384", "-r", "3"], 3],
  ],
});

export function buildBenchPlan({ executable, model, candidate, kind }) {
  const workloads = BENCH_KINDS[kind];
  if (!workloads) throw new Error("INVALID_BENCH_PLAN_KIND");
  const common = buildBenchCommonArgs({ model, candidate });
  return workloads.map(([id, suffix, expectedRepetitions]) => ({
    id,
    executable: text(executable, "llama_bench"),
    args: [...common, ...suffix],
    expected_repetitions: expectedRepetitions,
    shell: false,
  }));
}

export function buildServerArgv({ model, serverModelId, port, candidate }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("INVALID_SERVER_PORT");
  }
  const args = [
    "--model", text(model, "model"),
    "--alias", text(serverModelId, "server_model_id"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", integer(candidate.ctx_size, "ctx_size"),
    "--n-predict", "1024",
    "--batch-size", integer(candidate.batch, "batch"),
    "--ubatch-size", integer(candidate.ubatch, "ubatch"),
    "--threads", integer(candidate.threads, "threads"),
    "--threads-batch", integer(candidate.threads_batch, "threads_batch"),
    "--cpu-mask", text(candidate.cpu_mask, "cpu_mask"),
    "--cpu-strict", binary(candidate.cpu_strict),
    "--prio", priority(candidate.priority),
    "--poll", integer(candidate.poll, "poll"),
    "--n-gpu-layers", integer(candidate.n_gpu_layers, "n_gpu_layers"),
    "--n-cpu-moe", integer(candidate.n_cpu_moe, "n_cpu_moe"),
    "--cache-type-k", text(candidate.cache_type_k, "cache_type_k"),
    "--cache-type-v", text(candidate.cache_type_v, "cache_type_v"),
    "--flash-attn", text(candidate.flash_attn, "flash_attn"),
    "--device", backendDeviceList(candidate, ","),
    "--split-mode", text(candidate.split_mode, "split_mode"),
  ];
  const split = tensorSplit(candidate, ",");
  if (split) args.push("--tensor-split", split);
  args.push(
    candidate.op_offload ? "--op-offload" : "--no-op-offload",
    "--fit", "off",
    "--spec-type", "none",
    "--jinja",
    "--reasoning-format", text(candidate.reasoning_format, "reasoning_format"),
    "--reasoning-budget", "1024",
    // Server-only knob; llama-bench has no equivalent. Left unset, llama-server
    // defaults to 8192 MiB and grows a host-RAM prompt cache that competes with
    // the GGUF page cache. Recorded in the config so every result says which
    // value produced it.
    "--cache-ram", integer(candidate.cache_ram_mib, "cache_ram_mib"),
    "--parallel", "1",
    "--cont-batching",
    "--cache-prompt",
    "--metrics",
    "--slots",
    "--no-ui",
    "--no-warmup",
  );
  if (!candidate.kv_offload) args.push("--no-kv-offload");
  args.push(...loadFlags(candidate.load_mode, "server"));
  return args;
}
