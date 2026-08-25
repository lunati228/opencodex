import assert from "node:assert/strict";
import test from "node:test";

import {
  CPU_MOE_SWEEP,
  buildBenchPlan,
  buildServerArgv,
  coordinatedTensorSplit,
  validateCpuMoeSweep,
} from "../src/live-argv.mjs";

function candidate(overrides = {}) {
  return {
    load_mode: "mmap",
    backend_devices: ["CUDA0", "CUDA1"],
    split_mode: "layer",
    tensor_split: ["7", "9"],
    n_gpu_layers: 99,
    n_cpu_moe: 60,
    batch: 2048,
    ubatch: 512,
    threads: 16,
    threads_batch: 16,
    cpu_mask: "ffff",
    cpu_strict: true,
    priority: 1,
    poll: 50,
    flash_attn: "on",
    cache_type_k: "q8_0",
    cache_type_v: "q8_0",
    kv_offload: true,
    op_offload: true,
    cache_ram_mib: 0,
    fit: "off",
    spec_type: "none",
    ctx_size: 8192,
    generation_cap: 1024,
    reasoning_format: "deepseek",
    reasoning_budget: 1024,
    ...overrides,
  };
}

test("CPU-MoE sweep is validated by property, not by one pinned literal", () => {
  assert.deepEqual(CPU_MOE_SWEEP, [60, 58, 56, 54, 52, 50, 48]);
  assert.deepEqual(validateCpuMoeSweep([60, 58, 56, 54, 52, 50, 48]), CPU_MOE_SWEEP);

  // The researched coordinated ladder must be expressible. Hardcoding the
  // original list forced every campaign to open at n_cpu_moe=60, the worst
  // reachable placement, and it was the only value ever measured.
  assert.deepEqual(
    validateCpuMoeSweep([53, 52, 51, 50, 49, 48]),
    [53, 52, 51, 50, 49, 48],
  );
  assert.deepEqual(validateCpuMoeSweep([50]), [50]);

  // Strictly descending, so each step moves one more expert layer onto GPU
  // and successive candidates stay comparable.
  assert.throws(() => validateCpuMoeSweep([60, 56, 58, 48]), /INVALID_CPU_MOE_SWEEP_ORDER/);
  assert.throws(() => validateCpuMoeSweep([48, 50]), /INVALID_CPU_MOE_SWEEP_ORDER/);
  assert.throws(() => validateCpuMoeSweep([50, 50]), /INVALID_CPU_MOE_SWEEP_ORDER/);

  assert.throws(() => validateCpuMoeSweep([61]), /INVALID_CPU_MOE_SWEEP_VALUE/);
  assert.throws(() => validateCpuMoeSweep([-1]), /INVALID_CPU_MOE_SWEEP_VALUE/);
  assert.throws(() => validateCpuMoeSweep([50.5]), /INVALID_CPU_MOE_SWEEP_VALUE/);
  assert.throws(() => validateCpuMoeSweep([]), /INVALID_CPU_MOE_SWEEP_LENGTH/);
  assert.throws(() => validateCpuMoeSweep("50"), /INVALID_CPU_MOE_SWEEP_LENGTH/);
  assert.throws(
    () => validateCpuMoeSweep(Array.from({ length: 14 }, (_, i) => 60 - i)),
    /INVALID_CPU_MOE_SWEEP_LENGTH/,
  );
});

test("coordinated tensor split tracks n_cpu_moe so the two cannot drift", () => {
  assert.deepEqual(coordinatedTensorSplit(53), [53, 7]);
  assert.deepEqual(coordinatedTensorSplit(50), [50, 10]);
  assert.deepEqual(coordinatedTensorSplit(48), [48, 12]);
  assert.throws(() => coordinatedTensorSplit(61), /INVALID_ARGV_INTEGER/);
  assert.throws(() => coordinatedTensorSplit(-1), /INVALID_ARGV_INTEGER/);

  // Advancing the sweep must move the split with it. A fixed tensor_split
  // paired with a changing n_cpu_moe is the documented expert-tail OOM.
  for (const [nCpuMoe, expected] of [[53, "53/7"], [50, "50/10"], [48, "48/12"]]) {
    const [bench] = buildBenchPlan({
      executable: "C:\\llama\\llama-bench.exe",
      model: "G:\\model.gguf",
      candidate: candidate({
        backend_devices: ["CUDA0", "CUDA1"],
        tensor_split: "coordinated",
        n_cpu_moe: nCpuMoe,
      }),
      kind: "short",
    });
    assert.equal(bench.args[bench.args.indexOf("-ts") + 1], expected);
    assert.equal(bench.args[bench.args.indexOf("-ncmoe") + 1], String(nCpuMoe));
  }

  // Server spelling of the same pairing uses commas.
  const server = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8080,
    candidate: candidate({
      backend_devices: ["CUDA0", "CUDA1"],
      tensor_split: "coordinated",
      n_cpu_moe: 50,
    }),
  });
  assert.equal(server[server.indexOf("--tensor-split") + 1], "50,10");

  assert.throws(
    () =>
      buildBenchPlan({
        executable: "C:\\llama\\llama-bench.exe",
        model: "G:\\model.gguf",
        candidate: candidate({
          backend_devices: ["CUDA0"],
          tensor_split: "coordinated",
          n_cpu_moe: 50,
        }),
        kind: "short",
      }),
    /COORDINATED_TENSOR_SPLIT_REQUIRES_TWO_DEVICES/,
  );
});

test("bench multi-value parameters use slash, not comma", () => {
  // llama-bench declares `-ts <ts0/ts1/..>` and `-dev <dev0/dev1/...>`, and
  // separately documents ',' as the separator for enumerating *multiple test
  // values*. So `-ts 50,10` does not describe one 50/10 split - it silently
  // runs two tests, one at ts=50 and one at ts=10. Verified against the
  // installed b10099 parser. llama-server is the opposite: it declares
  // `N0,N1,N2,...` and takes commas.
  const dual = candidate({
    backend_devices: ["CUDA0", "CUDA1"],
    tensor_split: [50, 10],
    n_cpu_moe: 50,
  });
  const [bench] = buildBenchPlan({
    executable: "C:\\llama\\llama-bench.exe",
    model: "G:\\model.gguf",
    candidate: dual,
    kind: "short",
  });
  assert.equal(bench.args[bench.args.indexOf("-ts") + 1], "50/10");
  assert.equal(bench.args[bench.args.indexOf("-dev") + 1], "CUDA0/CUDA1");
  assert.ok(!bench.args.some((arg) => typeof arg === "string" && arg.includes(",")));

  const server = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8080,
    candidate: dual,
  });
  assert.equal(server[server.indexOf("--tensor-split") + 1], "50,10");
  assert.equal(server[server.indexOf("--device") + 1], "CUDA0,CUDA1");
});

test("short bench plan snapshots exact pinned argv including -ncmoe", () => {
  const plan = buildBenchPlan({
    executable: "C:\\llama\\llama-bench.exe",
    model: "G:\\model.gguf",
    candidate: candidate(),
    kind: "short",
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map(({ id }) => id), ["pp2k", "tg256-d2k"]);
  assert.deepEqual(plan[0].args.slice(-10), [
    "-o", "json", "-p", "2048", "-n", "0", "-d", "0", "-r", "3",
  ]);
  assert.deepEqual(plan[0].args.slice(-2), ["-r", "3"]);
  assert.equal(plan[0].args[plan[0].args.indexOf("-ts") + 1], "7/9");
  assert.ok(plan[0].args.includes("-ncmoe"));
  assert.ok(!plan[0].args.includes("-tb"));
  assert.ok(!plan[0].args.includes("--threads-batch"));
  assert.equal(plan[0].args[plan[0].args.indexOf("-ncmoe") + 1], "60");
  assert.ok(!plan[0].args.includes("-fitt"));
});

test("server argv is loopback-only and carries every pinned safety flag", () => {
  const args = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8088,
    candidate: candidate({ tensor_split: "auto", op_offload: false }),
  });
  assert.deepEqual(args.slice(0, 8), [
    "--model", "G:\\model.gguf", "--alias", "ornith-397b-featherweight",
    "--host", "127.0.0.1", "--port", "8088",
  ]);
  assert.equal(args[args.indexOf("--n-cpu-moe") + 1], "60");
  assert.equal(args[args.indexOf("--threads-batch") + 1], "16");
  assert.ok(args.includes("--no-op-offload"));
  assert.ok(args.includes("--fit"));
  assert.equal(args[args.indexOf("--fit") + 1], "off");
  assert.equal(args[args.indexOf("--spec-type") + 1], "none");
  assert.ok(args.includes("--no-warmup"));
  assert.ok(!args.includes("--tensor-split"));
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--agent"));
});

test("server argv always states cache-ram rather than inheriting the 8192 MiB default", () => {
  // Left unset, llama-server grows a host-RAM prompt cache of up to 8 GiB, which
  // on a 32 GB host evicts the GGUF page cache that decode throughput depends on.
  // The value must come from the config so every recorded result says which one
  // produced it; llama-bench has no equivalent flag and must not receive it.
  const args = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8080,
    candidate: candidate({ cache_ram_mib: 0 }),
  });
  assert.ok(args.includes("--cache-ram"));
  assert.equal(args[args.indexOf("--cache-ram") + 1], "0");

  const larger = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8080,
    candidate: candidate({ cache_ram_mib: 512 }),
  });
  assert.equal(larger[larger.indexOf("--cache-ram") + 1], "512");

  const plan = buildBenchPlan({
    executable: "C:\\llama\\llama-bench.exe",
    model: "G:\\model.gguf",
    candidate: candidate({ cache_ram_mib: 0 }),
    kind: "short",
  });
  const benchArgv = JSON.stringify(plan);
  assert.ok(!benchArgv.includes("--cache-ram"), "llama-bench has no --cache-ram");
  assert.ok(!benchArgv.includes("-cram"));
});

test("server argv uses the selected serving context instead of a hardcoded window", () => {
  const args = buildServerArgv({
    model: "G:\\model.gguf",
    serverModelId: "ornith-397b-featherweight",
    port: 8080,
    candidate: candidate({ ctx_size: 16_384 }),
  });

  assert.equal(args[args.indexOf("--ctx-size") + 1], "16384");
});
