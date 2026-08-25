import { MODEL_MOE_LAYERS, validateCpuMoeSweep } from "./live-argv.mjs";
import { hostSafetyLimitsFromConfig } from "./telemetry-live.mjs";
import { validateWindowsProcessControl } from "./windows-helper-trust.mjs";

function requiredInteger(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`INVALID_CONFIG_INTEGER: ${name}`);
  }
}

function requiredNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`INVALID_CONFIG_NUMBER: ${name}`);
  }
}

export function validatePinnedHostMonitor(value) {
  if (
    typeof value !== "string" ||
    value.replaceAll("/", "\\").toLowerCase() !==
      "c:\\windows\\system32\\typeperf.exe"
  ) {
    throw new Error("PINNED_HOST_MONITOR_MISMATCH");
  }
  return "C:\\Windows\\System32\\typeperf.exe";
}

export function validateLiveConfig(config) {
  for (const name of ["runtime_root", "runtime_manifest"]) {
    if (
      typeof config[name] !== "string" ||
      config[name].length === 0 ||
      !pathIsAbsolute(config[name])
    ) {
      throw new Error(`MISSING_REQUIRED_CONFIG: ${name}`);
    }
  }
  if (
    !/^[a-f0-9]{64}$/.test(
      config.expected?.runtime_manifest_sha256 ?? "",
    )
  ) {
    throw new Error(
      "MISSING_OR_INVALID_LIVE_HASH: runtime_manifest_sha256",
    );
  }
  const live = config.live;
  if (!live || typeof live !== "object" || Array.isArray(live)) {
    throw new Error("MISSING_REQUIRED_CONFIG: live");
  }
  for (const name of ["server_model_id", "nvidia_smi", "host_monitor"]) {
    if (typeof live[name] !== "string" || live[name].length === 0) {
      throw new Error(`MISSING_REQUIRED_LIVE_CONFIG: ${name}`);
    }
  }
  requiredInteger(live.server_port, "server_port", 1024);
  if (live.server_port > 65535) throw new Error("INVALID_SERVER_PORT");
  for (const name of [
    "telemetry_pre_roll_seconds",
    "telemetry_post_roll_seconds",
    "telemetry_max_gap_seconds",
    "abort_temperature_c",
    "minimum_free_gib",
  ]) {
    requiredNumber(live[name], name);
    if (live[name] < 0) throw new Error(`INVALID_LIVE_CONFIG_NUMBER: ${name}`);
  }
  if (
    live.telemetry_pre_roll_seconds !== 60 ||
    live.telemetry_post_roll_seconds !== 30 ||
    live.telemetry_max_gap_seconds !== 5
  ) {
    throw new Error("PINNED_TELEMETRY_WINDOW_MISMATCH");
  }
  validateWindowsProcessControl(live.windows_process_control);
  validatePinnedHostMonitor(live.host_monitor);
  if (
    !Number.isSafeInteger(live.expected_physical_memory_bytes) ||
    live.expected_physical_memory_bytes < 1
  ) {
    throw new Error("INVALID_EXPECTED_PHYSICAL_MEMORY_BYTES");
  }
  // Optional. Absent means the built-in defaults apply, so existing campaign
  // configs keep their exact prior behaviour. Validated here rather than at
  // first sample so a malformed reserve fails at load, not 90 seconds into a
  // run that has already mapped 119 GB.
  const hostReserve = hostSafetyLimitsFromConfig(live.host_reserve);
  if (
    hostReserve.available_reserve_bytes !== null &&
    hostReserve.available_reserve_bytes >= live.expected_physical_memory_bytes
  ) {
    throw new Error("HOST_RESERVE_EXCEEDS_PHYSICAL_MEMORY");
  }
  for (const name of ["bench_sha256", "server_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(config.expected?.[name] ?? "")) {
      throw new Error(`MISSING_OR_INVALID_LIVE_HASH: ${name}`);
    }
  }
  for (const name of [
    "install_manifest_sha256",
    "model_sha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(config.expected?.[name] ?? "")) {
      throw new Error(`MISSING_OR_INVALID_LIVE_HASH: ${name}`);
    }
  }
  if (
    typeof config.install_manifest !== "string" ||
    config.install_manifest.length === 0 ||
    !/^[a-f0-9]{40}$/.test(config.expected?.revision ?? "") ||
    !Number.isInteger(config.expected?.model_bytes) ||
    config.expected.model_bytes < 1
  ) {
    throw new Error("MISSING_LIVE_MODEL_IDENTITY_EVIDENCE");
  }
  if (
    !Number.isInteger(config.candidate.n_cpu_moe) ||
    config.candidate.n_cpu_moe < 0 ||
    config.candidate.n_cpu_moe > MODEL_MOE_LAYERS
  ) {
    throw new Error("INVALID_SHORT_SWEEP_N_CPU_MOE");
  }
  const sweep = live.cpu_moe_sweep;
  // Sweep length is declared per campaign and bound by the campaign hash; it
  // is derived here rather than fixed at seven so a ladder can be reshaped
  // between campaigns without editing the validator.
  const sweepLength = Array.isArray(sweep?.values) ? sweep.values.length : 0;
  if (
    !sweep ||
    typeof sweep !== "object" ||
    !Array.isArray(sweep.candidate_ids) ||
    sweepLength < 1 ||
    sweep.candidate_ids.length !== sweepLength ||
    sweep.candidate_ids.some(
      (value) =>
        typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    ) ||
    new Set(sweep.candidate_ids).size !== sweepLength ||
    !Number.isInteger(sweep.index) ||
    sweep.index < 0 ||
    sweep.index >= sweepLength
  ) {
    throw new Error("INVALID_CPU_MOE_SWEEP_DECLARATION");
  }
  validateCpuMoeSweep(sweep.values);
  if (
    sweep.candidate_ids[sweep.index] !== config.candidate_id ||
    sweep.values[sweep.index] !== config.candidate.n_cpu_moe
  ) {
    throw new Error("CPU_MOE_SWEEP_CANDIDATE_MISMATCH");
  }
  if (
    live.arm_comparison_manifest !== undefined &&
    (!pathIsAbsolute(live.arm_comparison_manifest) ||
      !/^[a-f0-9]{64}$/.test(live.arm_comparison_manifest_sha256 ?? ""))
  ) {
    throw new Error("INVALID_ARM_COMPARISON_MANIFEST_EVIDENCE");
  }
  return structuredClone(live);
}

export function validateCampaignConfig(config) {
  for (const name of [
    "campaign_id",
    "candidate_id",
    "result_root",
    "sandbox_root",
  ]) {
    if (typeof config[name] !== "string" || config[name].length === 0) {
      throw new Error(`MISSING_REQUIRED_CONFIG: ${name}`);
    }
  }
  if (
    !pathIsAbsolute(config.result_root) ||
    !pathIsAbsolute(config.sandbox_root)
  ) {
    throw new Error("RESULT_AND_SANDBOX_ROOTS_MUST_BE_ABSOLUTE");
  }
  for (const name of ["campaign_id", "candidate_id"]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config[name])) {
      throw new Error(`INVALID_SAFE_ID: ${name}`);
    }
  }
  const candidate = config.candidate;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("MISSING_REQUIRED_CONFIG: candidate");
  }
  if (candidate.llama_tag !== "b10099") throw new Error("LLAMA_TAG_NOT_B10099");
  if (!/^[a-f0-9]{40}$/.test(candidate.llama_commit)) {
    throw new Error("INVALID_LLAMA_COMMIT");
  }
  if (!["mmap", "dio", "none"].includes(candidate.load_mode)) {
    throw new Error("INVALID_LOAD_MODE");
  }
  if (
    !Array.isArray(candidate.device_order) ||
    ![1, 2].includes(candidate.device_order.length) ||
    candidate.device_order.some((value) => typeof value !== "string") ||
    new Set(candidate.device_order).size !== candidate.device_order.length
  ) {
    throw new Error("INVALID_DEVICE_ORDER");
  }
  if (
    !Array.isArray(candidate.backend_devices) ||
    candidate.backend_devices.length !== candidate.device_order.length ||
    candidate.backend_devices.some(
      (value) => typeof value !== "string" || !/^CUDA\d+$/.test(value),
    ) ||
    new Set(candidate.backend_devices).size !== candidate.backend_devices.length
  ) {
    throw new Error("INVALID_BACKEND_DEVICES");
  }
  if (!["layer", "row", "tensor"].includes(candidate.split_mode)) {
    throw new Error("INVALID_SPLIT_MODE");
  }
  if (candidate.experimental !== (candidate.split_mode === "tensor")) {
    throw new Error("EXPERIMENTAL_LABEL_MISMATCH");
  }
  const validShare = (value) => {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(number) && number > 0;
  };
  // "coordinated" derives the split from the candidate's own n_cpu_moe, so the
  // expert tail always lands on the device the split actually sized for it.
  if (
    candidate.tensor_split === "coordinated" &&
    candidate.backend_devices.length !== 2
  ) {
    throw new Error("INVALID_TENSOR_SPLIT");
  }
  if (
    candidate.tensor_split !== "auto" &&
    candidate.tensor_split !== "coordinated" &&
    (!Array.isArray(candidate.tensor_split) ||
      candidate.tensor_split.length !== candidate.backend_devices.length ||
      candidate.tensor_split.some((value) => !validShare(value)))
  ) {
    throw new Error("INVALID_TENSOR_SPLIT");
  }
  if (
    candidate.fit !== "off" ||
    candidate.spec_type !== "none" ||
    candidate.ctx_size !== 8192 ||
    candidate.generation_cap !== 1024 ||
    candidate.reasoning_budget !== 1024
  ) {
    throw new Error("PINNED_SAFETY_CONFIG_MISMATCH");
  }
  for (const name of [
    "n_gpu_layers",
    "n_cpu_moe",
    "batch",
    "ubatch",
    "threads",
    "threads_batch",
    "poll",
    // llama-server accepts -1 for "no limit"; requiredInteger's minimum of 0
    // rejects it deliberately. An unbounded host-RAM prompt cache on a 32 GB
    // machine would evict the GGUF page cache that decode throughput depends on.
    "cache_ram_mib",
  ]) {
    requiredInteger(candidate[name], name);
  }
  if (
    !Number.isInteger(candidate.priority) ||
    candidate.priority < -1 ||
    candidate.priority > 3
  ) {
    throw new Error("INVALID_CONFIG_INTEGER: priority");
  }
  if (
    typeof candidate.cpu_strict !== "boolean" ||
    typeof candidate.kv_offload !== "boolean" ||
    typeof candidate.op_offload !== "boolean"
  ) {
    throw new Error("INVALID_CONFIG_BOOLEAN");
  }
  if (!["on", "off"].includes(candidate.flash_attn)) {
    throw new Error("INVALID_FLASH_ATTN");
  }
  for (const name of [
    "cpu_mask",
    "cache_type_k",
    "cache_type_v",
    "reasoning_format",
  ]) {
    if (typeof candidate[name] !== "string" || candidate[name].length === 0) {
      throw new Error(`INVALID_CONFIG_STRING: ${name}`);
    }
  }
  requiredInteger(candidate.sampling?.seed, "seed");
  requiredInteger(candidate.sampling?.top_k, "top_k");
  for (const name of ["temperature", "top_p", "min_p"]) {
    requiredNumber(candidate.sampling?.[name], name);
  }
  return structuredClone(config);
}

function pathIsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}
