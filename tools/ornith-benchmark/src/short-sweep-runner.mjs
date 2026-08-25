import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";

import {
  appendRawArtifact,
  createCampaignLayout,
  writeDerivedJson,
} from "./artifacts.mjs";
import { runBenchPlan } from "./bench-runner.mjs";
import {
  createCampaignState,
  initializeCampaignState,
  loadCompletedCampaignState,
  loadCampaignState,
  markUnitComplete,
  shortSweepArtifactPolicy,
} from "./campaign-state.mjs";
import { canonicalJson, sha256Bytes } from "./hash.mjs";
import { buildBenchPlan } from "./live-argv.mjs";
import {
  validateCampaignConfig,
  validateLiveConfig,
} from "./config.mjs";
import { resolveContainedPath } from "./security.mjs";
import {
  startTelemetryCapture,
  stopTelemetryCapture,
} from "./telemetry-capture.mjs";
import {
  hostSafetyLimitsFromConfig,
  validateExpectedGpuMapping,
} from "./telemetry-live.mjs";
import {
  campaignInventoryPaths,
  ensureCampaignInventory,
} from "./campaign-inventory.mjs";

export function abortAwareDelay(
  milliseconds,
  signal,
  {
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new Error("INVALID_DELAY_DURATION"));
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("TELEMETRY_SAFETY_ABORT"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () =>
      finish(
        reject,
        signal.reason ?? new Error("TELEMETRY_SAFETY_ABORT"),
      );
    timer = setTimeoutFn(() => finish(resolve), milliseconds);
    if (settled) {
      clearTimeoutFn(timer);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function emptyDirectory(filePath) {
  try {
    const metadata = await stat(filePath);
    return metadata.isDirectory() && (await readdir(filePath)).length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function verifyFreeSpace(targetPath, minimumFreeGib) {
  const info = await statfs(path.parse(path.resolve(targetPath)).root);
  const freeBytes = Number(info.bavail) * Number(info.bsize);
  if (
    !Number.isFinite(freeBytes) ||
    freeBytes < minimumFreeGib * 1024 ** 3
  ) {
    throw new Error("INSUFFICIENT_RESULT_VOLUME_SPACE");
  }
  return freeBytes;
}

function identityForState(config, preflight, suite) {
  return {
    llama_tag: config.candidate.llama_tag,
    llama_commit: config.candidate.llama_commit,
    bench_sha256: preflight.paths.llama_bench.sha256,
    server_sha256: preflight.paths.llama_server.sha256,
    runtime_manifest_sha256:
      preflight.runtime_evidence?.manifest_sha256 ?? null,
    runtime_content_set_sha256:
      preflight.runtime_evidence?.content_set_sha256 ?? null,
    model_sha256:
      preflight.hash_evidence?.model_sha256 ??
      config.expected?.model_sha256 ??
      null,
    suite_sha256: suite.suite_sha256,
  };
}

function cpuMoeComparisonSha256(config) {
  const comparable = structuredClone(config);
  delete comparable.candidate_id;
  delete comparable.candidate.n_cpu_moe;
  delete comparable.live.cpu_moe_sweep.index;
  return sha256Bytes(canonicalJson(comparable));
}

export async function runShortSweep({
  config,
  preflight,
  suite,
  cwd,
  runtime = {},
}) {
  const delayFn = runtime.delay ?? abortAwareDelay;
  const runBenchPlanFn = runtime.runBenchPlan ?? runBenchPlan;
  const startTelemetryCaptureFn =
    runtime.startTelemetryCapture ?? startTelemetryCapture;
  const stopTelemetryCaptureFn =
    runtime.stopTelemetryCapture ?? stopTelemetryCapture;
  const totalMemoryFn = runtime.totalmem ?? totalmem;
  const verifyFreeSpaceFn = runtime.verifyFreeSpace ?? verifyFreeSpace;
  if (!preflight.hash_evidence?.model_sha256) {
    throw new Error("LIVE_MODEL_IDENTITY_EVIDENCE_MISSING");
  }
  const live = config.live;
  if (totalMemoryFn() !== live.expected_physical_memory_bytes) {
    throw new Error("PHYSICAL_MEMORY_IDENTITY_MISMATCH");
  }
  const expectedGpuMapping = validateExpectedGpuMapping(
    config.candidate.backend_devices.map(
      (backendDevice, index) => {
        const match = /^CUDA(\d+)$/.exec(backendDevice);
        if (!match) throw new Error("BACKEND_DEVICE_GPU_INDEX_UNRESOLVED");
        return {
          backend_device: backendDevice,
          gpu_index: Number(match[1]),
          gpu_uuid: config.candidate.device_order[index],
        };
      },
    ),
  );
  const configSha256 = sha256Bytes(canonicalJson(config));
  const identity = identityForState(config, preflight, suite);
  const identitySha256 = sha256Bytes(canonicalJson(identity));
  const comparisonSha256 = cpuMoeComparisonSha256(config);
  const candidateRoot = path.join(
    config.result_root,
    "candidates",
    config.candidate_id,
  );
  const statePath = path.join(candidateRoot, "campaign-state.json");
  const expectedState = {
    campaignId: config.campaign_id,
    candidateId: config.candidate_id,
    configSha256,
    identitySha256,
    comparisonSha256,
    artifactPolicy: shortSweepArtifactPolicy(
      config.result_root,
      candidateRoot,
    ),
  };
  const campaignPath = path.join(config.result_root, "campaign.json");
  const resultRootEmpty = await emptyDirectory(config.result_root);
  const sweep = live.cpu_moe_sweep;
  const sweepDeclaration = {
    values: sweep.values,
    candidate_ids: sweep.candidate_ids,
  };
  if (!resultRootEmpty) {
    if (!(await exists(campaignPath))) {
      throw new Error("RESULT_ROOT_EXISTS_WITHOUT_CAMPAIGN_IDENTITY");
    }
    const campaign = JSON.parse(await readFile(campaignPath, "utf8"));
    if (
      campaign.campaign_id !== config.campaign_id ||
      sha256Bytes(canonicalJson(campaign.identity)) !== identitySha256
    ) {
      throw new Error("CAMPAIGN_IDENTITY_MISMATCH");
    }
    if (
      JSON.stringify(campaign.cpu_moe_sweep) !==
        JSON.stringify(sweepDeclaration)
    ) {
      throw new Error("CPU_MOE_SWEEP_DECLARATION_CHANGED");
    }
    if (campaign.cpu_moe_comparison_sha256 !== comparisonSha256) {
      throw new Error("CPU_MOE_SWEEP_NON_CPU_MOE_CONFIG_CHANGED");
    }
    const containedCandidateRoot = await resolveContainedPath(
      config.result_root,
      path.join("candidates", config.candidate_id),
    );
    if (path.resolve(containedCandidateRoot) !== path.resolve(candidateRoot)) {
      throw new Error("RESULT_PATH_CONTAINMENT_FAILED");
    }
  }
  if (sweep.index > 0) {
    const priorId = sweep.candidate_ids[sweep.index - 1];
    const priorState = await loadCompletedCampaignState(
      path.join(
        config.result_root,
        "candidates",
        priorId,
        "campaign-state.json",
      ),
      {
        campaignId: config.campaign_id,
        candidateId: priorId,
        identitySha256,
        comparisonSha256,
        artifactPolicy: shortSweepArtifactPolicy(
          config.result_root,
          path.join(config.result_root, "candidates", priorId),
        ),
      },
    );
    if (priorState.units["sweep.short"]?.status !== "complete") {
      throw new Error("CPU_MOE_SWEEP_PREDECESSOR_INCOMPLETE");
    }
    const priorConfig = validateCampaignConfig(
      JSON.parse(
        await readFile(
          path.join(
            config.result_root,
            "candidates",
            priorId,
            "config.json",
          ),
          "utf8",
        ),
      ),
    );
    validateLiveConfig(priorConfig);
    if (
      priorConfig.candidate_id !== priorId ||
      priorConfig.live.cpu_moe_sweep.index !== sweep.index - 1 ||
      priorConfig.candidate.n_cpu_moe !== sweep.values[sweep.index - 1] ||
      JSON.stringify({
        values: priorConfig.live.cpu_moe_sweep.values,
        candidate_ids: priorConfig.live.cpu_moe_sweep.candidate_ids,
      }) !== JSON.stringify(sweepDeclaration) ||
      cpuMoeComparisonSha256(priorConfig) !== comparisonSha256
    ) {
      throw new Error("CPU_MOE_PREDECESSOR_CONFIG_MISMATCH");
    }
  }
  if (await exists(statePath)) {
    const state = await loadCampaignState(statePath, expectedState);
    if (state.units["sweep.short"]?.status === "complete") {
      return {
        ok: true,
        resumed: true,
        skipped_completed_unit: "sweep.short",
        state_path: statePath,
      };
    }
    throw new Error("RESUME_PARTIAL_UNIT_REJECTED");
  }

  await verifyFreeSpaceFn(config.result_root, live.minimum_free_gib);
  const layout = await createCampaignLayout(
    config.result_root,
    config.candidate_id,
  );
  await ensureCampaignInventory({
    resultRoot: config.result_root,
    config,
    preflight,
    suite,
    allowCreate: resultRootEmpty,
  });
  const initialArtifacts = [
    appendRawArtifact(
      path.join(candidateRoot, "config.json"),
      Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
    ),
  ];
  if (resultRootEmpty) {
    initialArtifacts.push(
      appendRawArtifact(
        campaignPath,
        Buffer.from(
          `${JSON.stringify({
            schema_version: "ornith-campaign-1",
            campaign_id: config.campaign_id,
            created_at_utc: new Date().toISOString(),
            identity,
            cpu_moe_sweep: sweepDeclaration,
            cpu_moe_comparison_sha256: comparisonSha256,
          }, null, 2)}\n`,
        ),
      ),
    );
  }
  await Promise.all(initialArtifacts);
  let state = await initializeCampaignState(
    statePath,
    createCampaignState(expectedState),
  );

  const plan = buildBenchPlan({
    executable: config.llama_bench,
    model: config.model,
    candidate: config.candidate,
    kind: "short",
  });
  const abortController = new AbortController();
  let requestInFlight = false;
  const telemetry = await startTelemetryCaptureFn({
    nvidiaSmi: live.nvidia_smi,
    hostMonitor: live.host_monitor,
    cwd,
    metadata: {
      campaign_id: config.campaign_id,
      run_id: `${config.candidate_id}-short`,
      candidate_id: config.candidate_id,
      phase: "sweep",
    },
    abortTemperatureC: live.abort_temperature_c,
    abortController,
    requestInFlight: () => requestInFlight,
    expectedGpuMapping,
    expectedPhysicalBytes: live.expected_physical_memory_bytes,
    maximumGapMs: live.telemetry_max_gap_seconds * 1000,
    hostSafetyLimits: hostSafetyLimitsFromConfig(live.host_reserve),
  });
  let benchResults;
  let telemetrySummary;
  let primaryError = null;
  try {
    await delayFn(
      live.telemetry_pre_roll_seconds * 1000,
      abortController.signal,
    );
    if (abortController.signal.aborted) {
      throw abortController.signal.reason ?? new Error("TELEMETRY_SAFETY_ABORT");
    }
    if (telemetry.query.closed() || telemetry.dmon.closed() || telemetry.host.closed()) {
      throw new Error("TELEMETRY_PROCESS_EXITED_DURING_PRE_ROLL");
    }
    requestInFlight = true;
    benchResults = await runBenchPlanFn({
      plan,
      candidateRoot,
      cwd,
      signal: abortController.signal,
    });
    requestInFlight = false;
    if (telemetry.query.closed() || telemetry.dmon.closed() || telemetry.host.closed()) {
      throw new Error("TELEMETRY_PROCESS_EXITED_DURING_BENCHMARK");
    }
    await delayFn(
      live.telemetry_post_roll_seconds * 1000,
      abortController.signal,
    );
    if (abortController.signal.aborted) {
      throw abortController.signal.reason ?? new Error("TELEMETRY_SAFETY_ABORT");
    }
    if (telemetry.query.closed() || telemetry.dmon.closed() || telemetry.host.closed()) {
      throw new Error("TELEMETRY_PROCESS_EXITED_DURING_POST_ROLL");
    }
  } catch (error) {
    primaryError = abortController.signal.aborted
      ? abortController.signal.reason ?? error
      : error;
  } finally {
    requestInFlight = false;
    try {
      telemetrySummary = await stopTelemetryCaptureFn(telemetry, {
        candidateRoot,
        rawDirectory: path.join(candidateRoot, "sweep", "telemetry"),
      });
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;

  const rawInputs = [
    campaignPath,
    ...campaignInventoryPaths(config.result_root),
    path.join(candidateRoot, "config.json"),
    ...benchResults.flatMap((result) => [
      result.raw_path,
      result.stderr_path,
      result.command_path,
    ]),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "nvidia-query.stdout.csv",
    ),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "nvidia-query.stderr.txt",
    ),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "nvidia-dmon.stdout.txt",
    ),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "nvidia-dmon.stderr.txt",
    ),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "host-monitor.stdout.csv",
    ),
    path.join(
      candidateRoot,
      "sweep",
      "telemetry",
      "host-monitor.stderr.txt",
    ),
  ];
  const summaryPath = path.join(candidateRoot, "sweep", "summary.json");
  await writeDerivedJson(
    summaryPath,
    {
      schema_version: "ornith-bench-1",
      campaign_id: config.campaign_id,
      candidate_id: config.candidate_id,
      phase: "sweep",
      n_cpu_moe: config.candidate.n_cpu_moe,
      workloads: benchResults,
      telemetry: telemetrySummary,
    },
    rawInputs,
  );
  state = await markUnitComplete(
    statePath,
    state,
    "sweep.short",
    [
      ...rawInputs,
      summaryPath,
      path.join(candidateRoot, "telemetry.csv"),
    ],
    expectedState.artifactPolicy,
  );
  return {
    ok: true,
    resumed: false,
    completed_unit: "sweep.short",
    candidate_root: layout.candidateRoot,
    state_path: statePath,
    workloads: benchResults,
    telemetry: telemetrySummary,
  };
}
