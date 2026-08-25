import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

import { buildBenchPlan, buildServerArgv } from "../src/live-argv.mjs";
import { liveProcessEnvironment } from "../src/process-live.mjs";

const llamaBench = process.env.ORNITH_TEST_LLAMA_BENCH ?? "";
const llamaServer = process.env.ORNITH_TEST_LLAMA_SERVER ?? "";
const canTestPinnedRuntime =
  process.platform === "win32" &&
  existsSync(llamaBench) &&
  existsSync(llamaServer);

function candidate() {
  return {
    load_mode: "mmap",
    backend_devices: ["CUDA0", "CUDA1"],
    split_mode: "layer",
    tensor_split: ["7", "9"],
    n_gpu_layers: 99,
    n_cpu_moe: 60,
    batch: 256,
    ubatch: 128,
    threads: 12,
    threads_batch: 12,
    cpu_mask: "0xfffff",
    cpu_strict: false,
    priority: 0,
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
    reasoning_format: "auto",
    reasoning_budget: 1024,
  };
}

function readHelp(executable) {
  const result = spawnSync(executable, ["--help"], {
    env: liveProcessEnvironment(),
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    result.status,
    0,
    `${executable} --help failed: ${
      result.stderr?.trim() || result.error?.message || "unknown error"
    }`,
  );
  return `${result.stdout}\n${result.stderr}`;
}

function assertOptionsDocumented(args, help) {
  const options = new Set(args.filter((argument) => /^--?[a-z]/i.test(argument)));
  for (const option of options) {
    const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      help,
      new RegExp(`(^|[\\s,])${escaped}(?=[\\s,]|$)`, "m"),
      `pinned runtime help does not document emitted option ${option}`,
    );
  }
}

test(
  "every emitted option exists on the pinned b10099 bench and server surfaces",
  { skip: !canTestPinnedRuntime },
  () => {
    const comparison = candidate();
    const bench = buildBenchPlan({
      executable: llamaBench,
      model: "G:\\model-is-not-opened.gguf",
      candidate: comparison,
      kind: "short",
    })[0];
    const server = buildServerArgv({
      model: "G:\\model-is-not-opened.gguf",
      serverModelId: "ornith-397b-featherweight",
      port: 8080,
      candidate: comparison,
    });

    assertOptionsDocumented(bench.args, readHelp(llamaBench));
    assertOptionsDocumented(server, readHelp(llamaServer));
  },
);
