import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { sha256Bytes } from "../src/hash.mjs";
import { buildRuntimeManifest } from "../src/runtime-manifest.mjs";
import { PINNED_WINDOWS_PROCESS_CONTROL } from "../src/windows-helper-trust.mjs";
import { tempRoot } from "./temp-root.mjs";

const execFileAsync = promisify(execFile);

test("CLI dry-run performs preflight and writes no campaign directory", async () => {
  const root = await tempRoot("ornith-dry-run-");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot);
  const bench = path.join(runtimeRoot, "llama-bench.exe");
  const server = path.join(runtimeRoot, "llama-server.exe");
  const runtimeManifest = path.join(root, "b10099.runtime.json");
  const model = path.join(root, "model.gguf");
  const nvidiaSmi = path.join(root, "nvidia-smi.exe");
  const hostMonitor = "C:\\Windows\\System32\\typeperf.exe";
  const resultRoot = path.join(root, "must-not-exist");
  const installManifest = path.join(root, "INSTALL-MANIFEST.json");
  const suite = path.resolve(
    new URL("../fixtures/ornith-quality-v1/manifest.json", import.meta.url).pathname.slice(1),
  );
  await Promise.all([
    writeFile(bench, "bench"),
    writeFile(server, "server"),
    writeFile(model, "tiny-test-model"),
    writeFile(nvidiaSmi, "nvidia"),
  ]);
  const runtimeValue = await buildRuntimeManifest({
    runtimeRoot,
    identity: {
      project: "ggml-org/llama.cpp",
      release_tag: "b10099",
      commit: "0".repeat(40),
      platform: "windows-x86_64",
      cuda_bundle: "13.3",
    },
    provenance: {
      install_manifest_path: path.join(root, "llama-install.json"),
      install_manifest_sha256: "f".repeat(64),
      archives: [
        {
          name: "fixture.zip",
          url: "https://github.com/ggml-org/llama.cpp/releases/download/b10099/fixture.zip",
          bytes: 1,
          sha256: "e".repeat(64),
        },
      ],
    },
    rolesForFile: () => ["test-runtime"],
  });
  const runtimeManifestBytes = Buffer.from(
    `${JSON.stringify(runtimeValue, null, 2)}\n`,
  );
  await writeFile(runtimeManifest, runtimeManifestBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    createdAt: "2026-07-24T00:00:00.000Z",
    installDirectory: root,
    repository: { immutableRevision: "d".repeat(40) },
    files: [{
      name: path.basename(model),
      bytes: 15,
      sha256: "c".repeat(64),
      expectedBytesMatch: true,
      expectedSHA256Match: true,
    }],
  }));
  await writeFile(installManifest, manifestBytes);
  const configPath = path.join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      campaign_id: "dry-run-test",
      candidate_id: "candidate-01",
      llama_bench: bench,
      llama_server: server,
      runtime_root: runtimeRoot,
      runtime_manifest: runtimeManifest,
      model,
      install_manifest: installManifest,
      quality_manifest: suite,
      result_root: resultRoot,
      sandbox_root: path.join(root, "sandbox"),
      live: {
        server_model_id: "ornith-397b-featherweight",
        server_port: 8088,
        nvidia_smi: nvidiaSmi,
        host_monitor: hostMonitor,
        windows_process_control: structuredClone(
          PINNED_WINDOWS_PROCESS_CONTROL,
        ),
        telemetry_pre_roll_seconds: 60,
        telemetry_post_roll_seconds: 30,
        telemetry_max_gap_seconds: 5,
        abort_temperature_c: 80,
        minimum_free_gib: 1,
        expected_physical_memory_bytes: os.totalmem(),
        cpu_moe_sweep: {
          values: [60, 58, 56, 54, 52, 50, 48],
          candidate_ids: [
            "candidate-01",
            "candidate-02",
            "candidate-03",
            "candidate-04",
            "candidate-05",
            "candidate-06",
            "candidate-07",
          ],
          index: 0,
        },
      },
      expected: {
        bench_sha256: sha256Bytes(Buffer.from("bench")),
        server_sha256: sha256Bytes(Buffer.from("server")),
        runtime_manifest_sha256: sha256Bytes(runtimeManifestBytes),
        install_manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        model_sha256: "c".repeat(64),
        revision: "d".repeat(40),
        model_bytes: 15,
        quality_suite_sha256:
          "3b1d8c0558eebf265c8da8a08ffee3b60d6009467bfdf76024335b89470d6b47",
      },
      candidate: {
        llama_tag: "b10099",
        llama_commit: "0".repeat(40),
        load_mode: "mmap",
        device_order: ["GPU-A", "GPU-B"],
        backend_devices: ["CUDA0", "CUDA1"],
        split_mode: "row",
        experimental: false,
        tensor_split: [1, 1],
        n_gpu_layers: 0,
        n_cpu_moe: 60,
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
    }),
  );

  const cli = path.resolve(
    new URL("../bin/ornith-benchmark.mjs", import.meta.url).pathname.slice(1),
  );
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "dry-run",
    "--config",
    configPath,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.case_count, 17);
  assert.equal(result.writes_performed, 0);
  assert.equal(
    result.live_plan.short_sweep[0].args[
      result.live_plan.short_sweep[0].args.indexOf("-ncmoe") + 1
    ],
    "60",
  );
  assert.equal(
    result.live_plan.server.args[
      result.live_plan.server.args.indexOf("--alias") + 1
    ],
    "ornith-397b-featherweight",
  );
  const { stdout: planStdout } = await execFileAsync(process.execPath, [
    cli,
    "plan-live",
    "--config",
    configPath,
  ]);
  const planned = JSON.parse(planStdout);
  assert.equal(planned.ok, true);
  assert.equal(planned.command, "plan-live");
  assert.equal(planned.writes_performed, 0);
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "run-short-sweep",
      "--config",
      configPath,
      "--confirm-live",
      "--hash-files",
    ]),
    (error) => /LIVE_COMMAND_FORBIDS_HASH_FILES/.test(error.stderr),
  );
  await assert.rejects(stat(resultRoot), { code: "ENOENT" });
});

async function stat(filePath) {
  return import("node:fs/promises").then((fs) => fs.stat(filePath));
}
