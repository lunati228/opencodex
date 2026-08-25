import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCampaignConfig,
  validateLiveConfig,
  validatePinnedHostMonitor,
} from "../src/config.mjs";

function config(tensorSplit, devices = ["CUDA0", "CUDA1"]) {
  return {
    campaign_id: "campaign",
    candidate_id: "candidate",
    result_root: "G:\\results",
    sandbox_root: "G:\\sandbox",
    runtime_root: "G:\\runtime",
    runtime_manifest: "G:\\manifests\\b10099.runtime.json",
    expected: {
      runtime_manifest_sha256: "b".repeat(64),
    },
    candidate: {
      llama_tag: "b10099",
      llama_commit: "a".repeat(40),
      load_mode: "mmap",
      device_order: devices.map((_, index) => `GPU-${index}`),
      backend_devices: devices,
      split_mode: "layer",
      experimental: false,
      tensor_split: tensorSplit,
      n_gpu_layers: 99,
      n_cpu_moe: 60,
      cache_ram_mib: 0,
      fit: "off",
      spec_type: "none",
      ctx_size: 8192,
      generation_cap: 1024,
      batch: 256,
      ubatch: 128,
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
      reasoning_format: "deepseek",
      reasoning_budget: 1024,
      sampling: { seed: 1, temperature: 0, top_p: 1, min_p: 0, top_k: 40 },
    },
  };
}

test("tensor split accepts exact auto for single and dual GPU", () => {
  assert.equal(validateCampaignConfig(config("auto")).candidate.tensor_split, "auto");
  assert.equal(
    validateCampaignConfig(config("auto", ["CUDA0"])).candidate.tensor_split,
    "auto",
  );
});

test("tensor split validates positive cardinality-matched proportions", () => {
  assert.deepEqual(validateCampaignConfig(config(["7", 9])).candidate.tensor_split, ["7", 9]);
  for (const malformed of [[], [1], [1, 0], [1, -2], [1, "x"], "AUTO"]) {
    assert.throws(() => validateCampaignConfig(config(malformed)), /INVALID_TENSOR_SPLIT/);
  }
});

test("live config requires a pinned runtime closure manifest", () => {
  const value = {
    live: {},
    runtime_manifest: "G:\\manifests\\b10099.runtime.json",
    expected: { runtime_manifest_sha256: "b".repeat(64) },
  };
  assert.throws(
    () => validateLiveConfig(value),
    /MISSING_REQUIRED_CONFIG: runtime_root/,
  );
});

test("host telemetry can only use the pinned System32 typeperf", () => {
  assert.equal(
    validatePinnedHostMonitor("C:\\WINDOWS\\system32\\typeperf.exe"),
    "C:\\Windows\\System32\\typeperf.exe",
  );
  for (const value of [
    "G:\\attacker\\typeperf.exe",
    "C:\\Windows\\System32\\..\\Temp\\typeperf.exe",
    "typeperf.exe",
  ]) {
    assert.throws(
      () => validatePinnedHostMonitor(value),
      /PINNED_HOST_MONITOR_MISMATCH/,
    );
  }
});
