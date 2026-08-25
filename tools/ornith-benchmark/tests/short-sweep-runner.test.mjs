import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendRawArtifact } from "../src/artifacts.mjs";
import { sha256File } from "../src/hash.mjs";
import { CAMPAIGN_INVENTORY_NAMES } from "../src/campaign-inventory.mjs";
import {
  abortAwareDelay,
  runShortSweep,
} from "../src/short-sweep-runner.mjs";
import { PINNED_WINDOWS_PROCESS_CONTROL } from "../src/windows-helper-trust.mjs";
import { tempRoot } from "./temp-root.mjs";

const SWEEP_VALUES = [60, 58, 56, 54, 52, 50, 48];
const CANDIDATE_IDS = SWEEP_VALUES.map((value) => `cpu-moe-${value}`);

function campaignConfig(resultRoot, index = 0) {
  const candidateId = CANDIDATE_IDS[index];
  return {
    campaign_id: "fake-short-sweep",
    candidate_id: candidateId,
    llama_bench: path.join(resultRoot, "llama-bench.exe"),
    llama_server: path.join(resultRoot, "llama-server.exe"),
    runtime_root: path.join(resultRoot, "runtime"),
    runtime_manifest: path.join(resultRoot, "b10099.runtime.json"),
    model: path.join(resultRoot, "model.gguf"),
    install_manifest: path.join(resultRoot, "INSTALL-MANIFEST.json"),
    quality_manifest: path.join(resultRoot, "quality.json"),
    result_root: resultRoot,
    sandbox_root: path.join(resultRoot, "sandbox"),
    live: {
      server_model_id: "ornith-fake",
      server_port: 8088,
      nvidia_smi: path.join(resultRoot, "nvidia-smi.exe"),
      host_monitor: "C:\\Windows\\System32\\typeperf.exe",
      windows_process_control: structuredClone(
        PINNED_WINDOWS_PROCESS_CONTROL,
      ),
      telemetry_pre_roll_seconds: 60,
      telemetry_post_roll_seconds: 30,
      telemetry_max_gap_seconds: 5,
      abort_temperature_c: 80,
      minimum_free_gib: 0,
      expected_physical_memory_bytes: 34_191_171_584,
      cpu_moe_sweep: {
        values: SWEEP_VALUES,
        candidate_ids: CANDIDATE_IDS,
        index,
      },
    },
    expected: {
      bench_sha256: "a".repeat(64),
      server_sha256: "b".repeat(64),
      runtime_manifest_sha256: "9".repeat(64),
      install_manifest_sha256: "c".repeat(64),
      model_sha256: "d".repeat(64),
      revision: "e".repeat(40),
      model_bytes: 119_517_476_064,
    },
    candidate: {
      llama_tag: "b10099",
      llama_commit: "f".repeat(40),
      load_mode: "mmap",
      device_order: ["GPU-FAKE-A", "GPU-FAKE-B"],
      backend_devices: ["CUDA0", "CUDA1"],
      split_mode: "row",
      experimental: false,
      tensor_split: [1, 1],
      n_gpu_layers: 0,
      n_cpu_moe: SWEEP_VALUES[index],
      cache_ram_mib: 0,
      fit: "off",
      spec_type: "none",
      ctx_size: 8192,
      generation_cap: 1024,
      batch: 512,
      ubatch: 128,
      threads: 8,
      threads_batch: 8,
      cpu_mask: "0xff",
      cpu_strict: false,
      priority: 0,
      poll: 50,
      flash_attn: "on",
      cache_type_k: "q8_0",
      cache_type_v: "q8_0",
      kv_offload: true,
      op_offload: true,
      reasoning_format: "auto",
      reasoning_budget: 1024,
      sampling: {
        seed: 1,
        temperature: 0,
        top_p: 1,
        min_p: 0,
        top_k: 40,
      },
    },
  };
}

function fakeInputs() {
  return {
    preflight: {
      paths: {
        llama_bench: { sha256: "a".repeat(64) },
        llama_server: { sha256: "b".repeat(64) },
      },
      hash_evidence: { model_sha256: "d".repeat(64) },
      runtime_evidence: {
        manifest_sha256: "9".repeat(64),
        content_set_sha256: "8".repeat(64),
      },
    },
    suite: { suite_sha256: "1".repeat(64) },
  };
}

function fakeService(closedValue = null) {
  return { closed: () => closedValue };
}

function fakeRuntime({
  abortDuringStart = false,
  closedDuringPreRoll = false,
  benchFailure = null,
  telemetryFailure = null,
} = {}) {
  const calls = { starts: 0, stops: 0, benches: 0, delays: [] };
  return {
    calls,
    runtime: {
      totalmem: () => 34_191_171_584,
      verifyFreeSpace: async () => 1024 ** 4,
      delay: async (milliseconds) => {
        calls.delays.push(milliseconds);
      },
      startTelemetryCapture: async ({ abortController, expectedGpuMapping }) => {
        calls.starts += 1;
        assert.deepEqual(expectedGpuMapping, [
          {
            backend_device: "CUDA0",
            gpu_index: 0,
            gpu_uuid: "GPU-FAKE-A",
          },
          {
            backend_device: "CUDA1",
            gpu_index: 1,
            gpu_uuid: "GPU-FAKE-B",
          },
        ]);
        if (abortDuringStart) {
          abortController.abort(new Error("FAKE_SAFETY_ABORT"));
        }
        const early = closedDuringPreRoll ? { code: 0, signal: null } : null;
        return {
          query: fakeService(early),
          dmon: fakeService(),
          host: fakeService(),
        };
      },
      stopTelemetryCapture: async (_capture, { rawDirectory }) => {
        calls.stops += 1;
        for (const name of [
          "nvidia-query.stdout.csv",
          "nvidia-query.stderr.txt",
          "nvidia-dmon.stdout.txt",
          "nvidia-dmon.stderr.txt",
          "host-monitor.stdout.csv",
          "host-monitor.stderr.txt",
        ]) {
          await appendRawArtifact(
            path.join(rawDirectory, name),
            Buffer.from(`fake ${name}\n`),
          );
        }
        if (telemetryFailure) throw new Error(telemetryFailure);
        return {
          samples: 4,
          dmon_summary: { samples: 2 },
          host_summary: { samples: 2 },
        };
      },
      runBenchPlan: async ({ plan, candidateRoot }) => {
        calls.benches += 1;
        const results = [];
        for (const workload of plan) {
          const directory = path.join(candidateRoot, "sweep");
          const rawPath = path.join(directory, `${workload.id}.raw.json`);
          const stderrPath = path.join(directory, `${workload.id}.stderr.txt`);
          const commandPath = path.join(directory, `${workload.id}.command.json`);
          await appendRawArtifact(rawPath, Buffer.from("[]\n"));
          await appendRawArtifact(stderrPath, Buffer.from(""));
          await appendRawArtifact(
            commandPath,
            Buffer.from('{"shell":false}\n'),
          );
          results.push({
            id: workload.id,
            raw_path: rawPath,
            stderr_path: stderrPath,
            command_path: commandPath,
            process: { exit_code: 0, duration_ms: 1, pid: 1234 },
            samples_ts: [],
            samples_ns: [],
            summary: {},
          });
          if (benchFailure && results.length === 1) {
            throw new Error(benchFailure);
          }
        }
        return results;
      },
    },
  };
}

async function freshRoot(label) {
  const parent = await tempRoot(`ornith-${label}-`);
  return path.join(parent, "results");
}

test("abort-aware delay clears its timer and rejects immediately on safety abort", async () => {
  const controller = new AbortController();
  const token = { id: "timer" };
  let callback = null;
  let cleared = null;
  const pending = abortAwareDelay(60_000, controller.signal, {
    setTimeoutFn(handler, milliseconds) {
      assert.equal(milliseconds, 60_000);
      callback = handler;
      return token;
    },
    clearTimeoutFn(value) {
      cleared = value;
    },
  });
  assert.equal(typeof callback, "function");
  controller.abort(new Error("FAKE_PROMPT_ABORT"));
  await assert.rejects(pending, /FAKE_PROMPT_ABORT/);
  assert.equal(cleared, token);
});

test("fake short sweep completes, binds every artifact, and resumes without rerunning", async () => {
  const resultRoot = await freshRoot("runner-success");
  const config = campaignConfig(resultRoot);
  const inputs = fakeInputs();
  const fake = fakeRuntime();
  const completed = await runShortSweep({
    config,
    ...inputs,
    cwd: path.dirname(resultRoot),
    runtime: fake.runtime,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.resumed, false);
  assert.equal(fake.calls.starts, 1);
  assert.equal(fake.calls.stops, 1);
  assert.equal(fake.calls.benches, 1);
  assert.deepEqual(fake.calls.delays, [60_000, 30_000]);
  const state = JSON.parse(await readFile(completed.state_path, "utf8"));
  assert.equal(state.units["sweep.short"].artifacts.length, 21);
  for (const name of CAMPAIGN_INVENTORY_NAMES) {
    const inventoryPath = path.join(resultRoot, "inventory", name);
    assert.ok(
      state.units["sweep.short"].artifacts.some(
        ({ path: artifactPath }) => artifactPath === inventoryPath,
      ),
    );
    assert.ok((await readFile(inventoryPath, "utf8")).length > 0);
  }

  const resumed = await runShortSweep({
    config,
    ...inputs,
    cwd: path.dirname(resultRoot),
    runtime: fake.runtime,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(fake.calls.starts, 1);
  assert.equal(fake.calls.benches, 1);

  await writeFile(
    path.join(resultRoot, "inventory", "host.txt"),
    "tampered\n",
  );
  await assert.rejects(
    runShortSweep({
      config,
      ...inputs,
      cwd: path.dirname(resultRoot),
      runtime: fake.runtime,
    }),
    /RESUME_ARTIFACT_HASH_MISMATCH/,
  );
});

test("short sweep rejects a fresh physical-memory mismatch before creating output", async () => {
  const resultRoot = await freshRoot("runner-memory");
  const fake = fakeRuntime();
  fake.runtime.totalmem = () => 34_191_171_583;
  await assert.rejects(
    runShortSweep({
      config: campaignConfig(resultRoot),
      ...fakeInputs(),
      cwd: path.dirname(resultRoot),
      runtime: fake.runtime,
    }),
    /PHYSICAL_MEMORY_IDENTITY_MISMATCH/,
  );
  assert.equal(fake.calls.starts, 0);
  await assert.rejects(readFile(path.join(resultRoot, "campaign.json")), {
    code: "ENOENT",
  });
});

test("fake short sweep always stops telemetry on safety abort, early exit, or no coverage", async () => {
  for (const scenario of [
    {
      label: "abort",
      options: { abortDuringStart: true },
      expected: /FAKE_SAFETY_ABORT/,
    },
    {
      label: "early",
      options: { closedDuringPreRoll: true },
      expected: /TELEMETRY_PROCESS_EXITED_DURING_PRE_ROLL/,
    },
    {
      label: "coverage",
      options: { telemetryFailure: "INSUFFICIENT_TELEMETRY_COVERAGE" },
      expected: /INSUFFICIENT_TELEMETRY_COVERAGE/,
    },
  ]) {
    const resultRoot = await freshRoot(`runner-${scenario.label}`);
    const fake = fakeRuntime(scenario.options);
    await assert.rejects(
      runShortSweep({
        config: campaignConfig(resultRoot),
        ...fakeInputs(),
        cwd: path.dirname(resultRoot),
        runtime: fake.runtime,
      }),
      scenario.expected,
    );
    assert.equal(fake.calls.starts, 1);
    assert.equal(fake.calls.stops, 1);
    if (scenario.label !== "coverage") {
      assert.equal(fake.calls.benches, 0);
    }
  }
});

test("real pre-roll timer abort stops telemetry promptly instead of waiting 60 seconds", async () => {
  const resultRoot = await freshRoot("runner-prompt-abort");
  const fake = fakeRuntime();
  delete fake.runtime.delay;
  const start = fake.runtime.startTelemetryCapture;
  fake.runtime.startTelemetryCapture = async (input) => {
    const capture = await start(input);
    setTimeout(
      () => input.abortController.abort(new Error("PROMPT_MONITOR_ABORT")),
      20,
    );
    return capture;
  };
  const startedAt = performance.now();
  await assert.rejects(
    runShortSweep({
      config: campaignConfig(resultRoot),
      ...fakeInputs(),
      cwd: path.dirname(resultRoot),
      runtime: fake.runtime,
    }),
    /PROMPT_MONITOR_ABORT/,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `cleanup took ${elapsedMs} ms`);
  assert.equal(fake.calls.stops, 1);
  assert.equal(fake.calls.benches, 0);
});

test("partial fake unit is immutable and retry is rejected before another process starts", async () => {
  const resultRoot = await freshRoot("runner-partial");
  const config = campaignConfig(resultRoot);
  const failed = fakeRuntime({ benchFailure: "FAKE_BENCH_FAILURE" });
  await assert.rejects(
    runShortSweep({
      config,
      ...fakeInputs(),
      cwd: path.dirname(resultRoot),
      runtime: failed.runtime,
    }),
    /FAKE_BENCH_FAILURE/,
  );
  assert.equal(failed.calls.stops, 1);
  const retry = fakeRuntime();
  await assert.rejects(
    runShortSweep({
      config,
      ...fakeInputs(),
      cwd: path.dirname(resultRoot),
      runtime: retry.runtime,
    }),
    /RESUME_PARTIAL_UNIT_REJECTED/,
  );
  assert.equal(retry.calls.starts, 0);
  assert.equal(retry.calls.benches, 0);
});

test("predecessor state is hash-bound and its prior config is semantically revalidated", async () => {
  const resultRoot = await freshRoot("runner-predecessor");
  const inputs = fakeInputs();
  const first = fakeRuntime();
  await runShortSweep({
    config: campaignConfig(resultRoot, 0),
    ...inputs,
    cwd: path.dirname(resultRoot),
    runtime: first.runtime,
  });

  const priorRoot = path.join(resultRoot, "candidates", CANDIDATE_IDS[0]);
  const priorConfigPath = path.join(priorRoot, "config.json");
  const priorStatePath = path.join(priorRoot, "campaign-state.json");
  const priorConfig = JSON.parse(await readFile(priorConfigPath, "utf8"));
  priorConfig.candidate.batch += 1;
  await writeFile(priorConfigPath, `${JSON.stringify(priorConfig, null, 2)}\n`);
  const priorState = JSON.parse(await readFile(priorStatePath, "utf8"));
  const configArtifact = priorState.units["sweep.short"].artifacts.find(
    ({ path: artifactPath }) => artifactPath === priorConfigPath,
  );
  configArtifact.sha256 = await sha256File(priorConfigPath);
  await writeFile(priorStatePath, `${JSON.stringify(priorState, null, 2)}\n`);

  const second = fakeRuntime();
  await assert.rejects(
    runShortSweep({
      config: campaignConfig(resultRoot, 1),
      ...inputs,
      cwd: path.dirname(resultRoot),
      runtime: second.runtime,
    }),
    /CPU_MOE_PREDECESSOR_CONFIG_MISMATCH/,
  );
  assert.equal(second.calls.starts, 0);
  assert.equal(second.calls.benches, 0);
});
