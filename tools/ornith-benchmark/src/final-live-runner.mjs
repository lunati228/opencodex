import { hostname, totalmem } from "node:os";
import { readFile, readdir, statfs } from "node:fs/promises";
import path from "node:path";

import {
  appendRawArtifact,
  appendRoundRecords,
  ensureCandidateAppendStreams,
  writeDerivedJson,
} from "./artifacts.mjs";
import { runBenchPlan } from "./bench-runner.mjs";
import { materializeCase } from "./fixture.mjs";
import {
  eraseSlotZero,
  streamLoopbackChat,
  tokenizeTextLive,
  verifyRenderedPromptLive,
} from "./http-live.mjs";
import { buildBenchPlan } from "./live-argv.mjs";
import { runToolCase } from "./quality-loop.mjs";
import {
  queryExclusiveExpectedGpuProcess,
  waitForExclusiveExpectedGpuProcess,
} from "./gpu-process-guard.mjs";
import { startOrnithServer, stopOrnithServer } from "./server-runner.mjs";
import { abortAwareDelay } from "./short-sweep-runner.mjs";
import {
  startTelemetryCapture,
  stopTelemetryCapture,
} from "./telemetry-capture.mjs";
import {
  hostSafetyLimitsFromConfig,
  validateExpectedGpuMapping,
} from "./telemetry-live.mjs";
import { executeTool } from "./tools.mjs";
import { sha256File } from "./hash.mjs";
import { validateResult, validateRound } from "./schema.mjs";

const SUSTAINED_ORDER = Object.freeze([
  "E-01",
  "D-01",
  "T-01",
  "A-01",
  "E-04",
  "R-01",
  "T-03",
  "S-02",
]);
const MUTATING_CATEGORIES = new Set([
  "edit",
  "debug",
  "tool_chain",
  "second_attempt",
]);

function expectedGpuMapping(config) {
  return validateExpectedGpuMapping(
    config.candidate.backend_devices.map((backendDevice, index) => {
      const match = /^CUDA(\d+)$/.exec(backendDevice);
      if (!match) throw new Error("BACKEND_DEVICE_GPU_INDEX_UNRESOLVED");
      return {
        backend_device: backendDevice,
        gpu_index: Number(match[1]),
        gpu_uuid: config.candidate.device_order[index],
      };
    }),
  );
}

function rawTelemetryPaths(directory) {
  return [
    "nvidia-query.stdout.csv",
    "nvidia-query.stderr.txt",
    "nvidia-dmon.stdout.txt",
    "nvidia-dmon.stderr.txt",
    "host-monitor.stdout.csv",
    "host-monitor.stderr.txt",
  ].map((name) => path.join(directory, "telemetry", name));
}

function protocolPhase(unitId) {
  if (/^cold-[1-3]$/.test(unitId)) return "cold";
  if (unitId === "warm-quality") return "warm";
  if (unitId === "sustained") return "sustained";
  throw new Error(`UNIT_MODEL_ROUND_PHASE_INVALID: ${unitId}`);
}

export function modelRoundRecords(config, preflight, unitId, cases) {
  const output = [];
  const phase = protocolPhase(unitId);
  for (const [caseOffset, item] of cases.entries()) {
    const rounds = item.run?.rounds ??
      (item.round
        ? [{
            ...item.round,
            cache_n: item.round.timings?.cache_n,
            prompt_n: item.round.timings?.prompt_n,
            prompt_ms: item.round.timings?.prompt_ms,
            predicted_n: item.round.timings?.predicted_n,
            predicted_ms: item.round.timings?.predicted_ms,
            decode_tok_s:
              Number.isInteger(item.round.timings?.predicted_n) &&
              Number.isFinite(item.round.timings?.predicted_ms) &&
              item.round.timings.predicted_ms > 0
                ? item.round.timings.predicted_n /
                  (item.round.timings.predicted_ms / 1000)
                : null,
            normal_speed_sample:
              Number.isInteger(item.round.timings?.predicted_n) &&
              item.round.timings.predicted_n >= 64,
          }]
        : []);
    for (const [roundOffset, round] of rounds.entries()) {
      const reasoningTokens =
        round.reasoning_tokens ??
        round.usage?.completion_tokens_details?.reasoning_tokens ??
        null;
      const answerTokens =
        round.answer_tokens ??
        round.usage?.completion_tokens ??
        null;
      output.push(validateRound({
        schema_version: "ornith-bench-1",
        campaign_id: config.campaign_id,
        run_id: `${config.candidate_id}-${unitId}-${caseOffset}`,
        candidate_id: config.candidate_id,
        phase,
        case_id: item.case_id,
        round_index: Number.isInteger(round.round_index)
          ? round.round_index
          : roundOffset,
        started_at_utc: round.started_at_utc ?? new Date().toISOString(),
        llama_tag: config.candidate.llama_tag,
        llama_commit: config.candidate.llama_commit,
        server_sha256: preflight.paths.llama_server.sha256,
        model_sha256: preflight.hash_evidence.model_sha256,
        host_id: hostname(),
        load_mode: config.candidate.load_mode,
        use_mmap: config.candidate.load_mode === "mmap",
        use_direct_io: config.candidate.load_mode === "dio",
        fit: config.candidate.fit,
        device_order: config.candidate.backend_devices.join("/"),
        gpu_uuid_order: config.candidate.device_order.join("/"),
        pci_bus_order: config.candidate.pci_bus_order?.join("/") ?? null,
        split_mode: config.candidate.split_mode,
        experimental: config.candidate.experimental,
        tensor_split: Array.isArray(config.candidate.tensor_split)
          ? config.candidate.tensor_split.join("/")
          : config.candidate.tensor_split,
        n_gpu_layers: config.candidate.n_gpu_layers,
        n_cpu_moe: config.candidate.n_cpu_moe,
        ctx_size: config.candidate.ctx_size,
        generation_cap: config.candidate.generation_cap,
        batch: config.candidate.batch,
        ubatch: config.candidate.ubatch,
        threads: config.candidate.threads,
        threads_batch: config.candidate.threads_batch,
        cpu_mask: config.candidate.cpu_mask,
        cpu_strict: config.candidate.cpu_strict,
        priority: config.candidate.priority,
        poll: config.candidate.poll,
        flash_attn: config.candidate.flash_attn,
        cache_type_k: config.candidate.cache_type_k,
        cache_type_v: config.candidate.cache_type_v,
        kv_offload: config.candidate.kv_offload,
        op_offload: config.candidate.op_offload,
        cache_ram_mib: config.candidate.cache_ram_mib,
        spec_type: config.candidate.spec_type,
        reasoning_format: config.candidate.reasoning_format,
        reasoning_budget: config.candidate.reasoning_budget,
        ...config.candidate.sampling,
        prompt_target:
          config.candidate.ctx_size - config.candidate.generation_cap,
        gen_target: config.candidate.generation_cap,
        request_start_ns: round.request_start_ns ?? null,
        request_sent_ns: round.request_sent_ns ?? null,
        first_sse_event_ns: round.first_sse_event_ns ?? null,
        first_output_ns: round.first_output_ns ?? null,
        response_end_ns: round.response_end_ns ?? null,
        cache_n: round.cache_n,
        prompt_n: round.prompt_n,
        prompt_ms: round.prompt_ms,
        prefill_tok_s: round.prefill_tok_s,
        predicted_n: round.predicted_n,
        predicted_ms: round.predicted_ms,
        decode_tok_s: round.decode_tok_s,
        ttft_ms: round.ttft_ms,
        post_upload_ttft_ms: round.post_upload_ttft_ms,
        total_wall_ms: round.total_wall_ms,
        reasoning_tokens: reasoningTokens,
        answer_tokens: answerTokens,
        tool_calls: structuredClone(round.tool_calls ?? []),
        tool_call_count: round.tool_calls?.length ?? 0,
        tool_round_index: item.run?.tool_round_count ?? 0,
        tool_latency_ms_sum: round.tool_latency_ms_sum ?? 0,
        tool_round_wall_ms: round.tool_round_wall_ms ?? 0,
        normal_speed_sample: Boolean(round.normal_speed_sample),
        outcome: item.score?.passed === false ? "fail" : "pass",
        tests_passed: item.score?.final_tests?.ok === true ? 1 : null,
        tests_total: item.score?.final_tests ? 1 : null,
        unauthorized_change: false,
        malformed_tool_call: false,
        retry_count: 0,
        abort_reason: round.abort_reason ?? null,
      }));
    }
  }
  if (output.length < 1) throw new Error("UNIT_MODEL_ROUNDS_MISSING");
  return output;
}

async function candidateArtifactClosure(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      relative === "result.json" ||
      relative === "final-campaign-state.json"
    ) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await candidateArtifactClosure(absolute, relative));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      output.push({ relative, absolute });
    } else {
      throw new Error("CANDIDATE_ARTIFACT_CLOSURE_INVALID");
    }
  }
  return output.sort((left, right) =>
    left.relative.localeCompare(right.relative));
}

export async function runMonitoredRequest({
  request,
  initialExpectedPid,
  validateExpectedPid,
  verifyFreeSpace,
  controller,
  intervalMs = 1_000,
}) {
  if (
    typeof request !== "function" ||
    typeof validateExpectedPid !== "function" ||
    typeof verifyFreeSpace !== "function" ||
    !(controller instanceof AbortController) ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1
  ) {
    throw new Error("REQUEST_MONITOR_INPUT_INVALID");
  }
  let expectedPid = initialExpectedPid;
  let expectedPidValidated = false;
  const setExpectedPid = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("EXPECTED_GPU_PROCESS_IDENTITY_INVALID");
    }
    if (expectedPid !== undefined && expectedPid !== pid) {
      throw new Error("EXPECTED_GPU_PROCESS_IDENTITY_CHANGED");
    }
    expectedPid = pid;
  };
  const validateExpectedPidNow = async (pid) => {
    setExpectedPid(pid);
    await validateExpectedPid(pid);
    expectedPidValidated = true;
  };
  if (expectedPid !== undefined) setExpectedPid(expectedPid);
  const check = async () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("COMMAND_ABORTED");
    }
    await verifyFreeSpace();
    if (expectedPid !== undefined) {
      await validateExpectedPidNow(expectedPid);
    }
  };
  try {
    await check();
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw controller.signal.reason ?? error;
  }

  let stopped = false;
  let wake = null;
  let timer = null;
  let monitorError = null;
  const waitInterval = () =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  const monitor = (async () => {
    while (!stopped) {
      await waitInterval();
      wake = null;
      timer = null;
      if (stopped) break;
      try {
        await check();
      } catch (error) {
        monitorError =
          controller.signal.aborted
            ? controller.signal.reason ?? error
            : error;
        if (!controller.signal.aborted) controller.abort(monitorError);
        break;
      }
    }
  })();

  let value;
  let requestError = null;
  try {
    value = await request({
      setExpectedPid,
      validateExpectedPidNow,
    });
  } catch (error) {
    requestError = error;
  } finally {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    wake?.();
    await monitor;
  }
  if (monitorError === null && requestError === null) {
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("COMMAND_ABORTED");
      }
      await verifyFreeSpace();
      if (expectedPid !== undefined && !expectedPidValidated) {
        throw new Error("EXPECTED_GPU_PROCESS_COVERAGE_MISSING");
      }
    } catch (error) {
      monitorError =
        controller.signal.aborted
          ? controller.signal.reason ?? error
          : error;
      if (!controller.signal.aborted) controller.abort(monitorError);
    }
  }
  if (monitorError) throw monitorError;
  if (requestError) throw requestError;
  return value;
}

async function withTelemetry({
  config,
  cwd,
  unitId,
  artifactDirectory,
  runtime,
  action,
}) {
  const live = config.live;
  const controller = new AbortController();
  let requestInFlight = false;
  let requestDepth = 0;
  const verifyFreeSpace = async () => {
    const root = path.parse(path.resolve(config.result_root)).root;
    const info = await statfs(root);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    if (
      !Number.isFinite(freeBytes) ||
      freeBytes < live.minimum_free_gib * 1024 ** 3
    ) {
      throw new Error("INSUFFICIENT_RESULT_VOLUME_SPACE");
    }
  };
  await verifyFreeSpace();
  const validateExpectedPid =
    runtime.validateExpectedGpuProcess ??
    ((expectedPid) =>
      waitForExclusiveExpectedGpuProcess({
        nvidiaSmi: live.nvidia_smi,
        cwd,
        expectedPid,
        expectedGpuUuids: config.candidate.device_order,
        signal: controller.signal,
      }));
  const validateExpectedPidNow =
    runtime.validateExpectedGpuProcessNow ??
    runtime.validateExpectedGpuProcess ??
    ((expectedPid) =>
      queryExclusiveExpectedGpuProcess({
        nvidiaSmi: live.nvidia_smi,
        cwd,
        expectedPid,
        expectedGpuUuids: config.candidate.device_order,
        signal: controller.signal,
      }));
  const requestWindow = async (request, { expectedPid } = {}) => {
    if (requestDepth !== 0) throw new Error("REQUEST_WINDOW_OVERLAP");
    await verifyFreeSpace();
    if (expectedPid !== undefined) await validateExpectedPid(expectedPid);
    requestDepth = 1;
    requestInFlight = true;
    try {
      return await runMonitoredRequest({
        request,
        initialExpectedPid: expectedPid,
        validateExpectedPid: validateExpectedPidNow,
        verifyFreeSpace,
        controller,
        intervalMs: runtime.requestMonitorIntervalMs ?? 1_000,
      });
    } finally {
      requestInFlight = false;
      requestDepth = 0;
    }
  };
  const telemetry = await (runtime.startTelemetryCapture ?? startTelemetryCapture)({
    nvidiaSmi: live.nvidia_smi,
    hostMonitor: live.host_monitor,
    cwd,
    metadata: {
      campaign_id: config.campaign_id,
      run_id: `${config.candidate_id}-${unitId}`,
      candidate_id: config.candidate_id,
      phase: unitId,
    },
    abortTemperatureC: live.abort_temperature_c,
    abortController: controller,
    requestInFlight: () => requestInFlight,
    expectedGpuMapping: expectedGpuMapping(config),
    expectedPhysicalBytes: live.expected_physical_memory_bytes,
    maximumGapMs: live.telemetry_max_gap_seconds * 1000,
    hostSafetyLimits: hostSafetyLimitsFromConfig(live.host_reserve),
  });
  const delay = runtime.delay ?? abortAwareDelay;
  let value;
  let summary;
  let primaryError;
  try {
    await delay(live.telemetry_pre_roll_seconds * 1000, controller.signal);
    value = await action(controller.signal, telemetry, requestWindow);
    await delay(live.telemetry_post_roll_seconds * 1000, controller.signal);
  } catch (error) {
    primaryError = controller.signal.aborted
      ? controller.signal.reason ?? error
      : error;
  } finally {
    requestInFlight = false;
    try {
      summary = await (runtime.stopTelemetryCapture ?? stopTelemetryCapture)(
        telemetry,
        {
          candidateRoot: path.join(
            config.result_root,
            "candidates",
            config.candidate_id,
          ),
          rawDirectory: path.join(artifactDirectory, "telemetry"),
        },
      );
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  validateFinalTelemetrySummary(
    summary,
    config.candidate.device_order,
  );
  return { value, telemetry: summary };
}

export function validateFinalTelemetrySummary(summary, gpuUuids) {
  if (summary?.dmon_summary?.thermal_violation_observed) {
    throw new Error("FINAL_THERMAL_VIOLATION_OBSERVED");
  }
  for (const uuid of gpuUuids) {
    const query = summary?.by_gpu?.[uuid];
    const dmon = summary?.dmon_summary?.by_gpu?.[uuid];
    if (
      !Number.isSafeInteger(query?.active_samples) ||
      query.active_samples < 1 ||
      !Number.isFinite(query.pcie_gen_min_active) ||
      query.pcie_gen_min_active <= 0 ||
      !Number.isFinite(query.pcie_width_min_active) ||
      query.pcie_width_min_active <= 0 ||
      !Number.isFinite(dmon?.pcie_rx_mb_s_p95) ||
      dmon.pcie_rx_mb_s_p95 < 0 ||
      !Number.isFinite(dmon?.pcie_tx_mb_s_p95) ||
      dmon.pcie_tx_mb_s_p95 < 0
    ) {
      throw new Error(`FINAL_ACTIVE_PCIE_EVIDENCE_INVALID: ${uuid}`);
    }
    if (
      query.pcie_gen_min_active === 1 &&
      query.pcie_width_min_active === 1
    ) {
      throw new Error(`FINAL_ACTIVE_PCIE_LINK_UNUSABLE: ${uuid}`);
    }
  }
}

function allToolCalls(run) {
  return run.rounds.flatMap((round) => round.tool_calls);
}

function summarizeQuality(cases) {
  const categories = {};
  for (const { category, score } of cases) {
    const current = categories[category] ?? { passed: 0, total: 0 };
    current.total += 1;
    if (score.passed) current.passed += 1;
    categories[category] = current;
  }
  const passed = cases.filter(({ score }) => score.passed).length;
  const baselinePass =
    passed >= 15 &&
    categories.edit?.passed >= 4 &&
    categories.debug?.passed >= 2 &&
    categories.tool_chain?.passed === 3 &&
    categories.ambiguous?.passed >= 1 &&
    categories.stop_ask?.passed === 2 &&
    categories.second_attempt?.passed === 2;
  const exceptional =
    passed >= 16 &&
    categories.tool_chain?.passed === 3 &&
    categories.ambiguous?.passed === 2 &&
    categories.stop_ask?.passed === 2 &&
    categories.second_attempt?.passed === 2;
  return {
    passed,
    total: 17,
    categories,
    baseline_pass: baselinePass,
    exceptional,
  };
}

function median(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("FINAL_DECISION_SAMPLE_SET_INVALID");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function selectSustainedScoringSamples(cases) {
  const samples = [];
  for (const [caseIndex, item] of cases.entries()) {
    if (!item?.run || !Array.isArray(item.run.rounds)) {
      throw new Error("SUSTAINED_CASE_EVIDENCE_INVALID");
    }
    for (const [roundOffset, round] of item.run.rounds.entries()) {
      if (!Number.isInteger(round.predicted_n) || round.predicted_n < 64) {
        continue;
      }
      if (
        !Number.isFinite(round.predicted_ms) ||
        round.predicted_ms <= 0 ||
        !Number.isFinite(round.decode_tok_s) ||
        round.decode_tok_s <= 0
      ) {
        throw new Error("SUSTAINED_SCORING_SAMPLE_INVALID");
      }
      const roundIndex = Number.isInteger(round.round_index)
        ? round.round_index
        : roundOffset;
      samples.push({
        sample_id: `${item.case_id}:${caseIndex}:${roundIndex}`,
        case_index: caseIndex,
        case_id: item.case_id,
        round_index: roundIndex,
        predicted_n: round.predicted_n,
        predicted_ms: round.predicted_ms,
        decode_tok_s: round.decode_tok_s,
      });
    }
  }
  return samples;
}

export function decideCandidate({
  median8,
  median16,
  sustainedMedian,
  minimumNormalSample,
  quality,
}) {
  const values = [
    median8,
    median16,
    sustainedMedian,
    minimumNormalSample,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    typeof quality?.baseline_pass !== "boolean" ||
    typeof quality?.exceptional !== "boolean"
  ) {
    return {
      decision: "INVALID",
      speed_band: null,
      minimum_median_decode_ts: null,
      minimum_normal_sample_ts: null,
      sustained_median_decode_ts: null,
      reasons: ["required final measurement or quality result missing"],
    };
  }
  const minimumMedian = Math.min(median8, median16, sustainedMedian);
  const speedBand =
    sustainedMedian < 2.5
      ? "lt_2_5"
      : sustainedMedian < 3
        ? "gte_2_5_lt_3_0"
        : sustainedMedian < 3.5
          ? "gte_3_0_lt_3_5"
          : sustainedMedian <= 4
            ? "gte_3_5_lte_4_0"
            : "gt_4_0";
  let decision;
  const reasons = [];
  if (minimumNormalSample < 2.5) {
    decision = "REMOVE";
    reasons.push("normal speed sample below 2.5 tokens/s");
  } else if (minimumMedian < 3) {
    decision = "FAIL";
    reasons.push("minimum median below 3.0 tokens/s");
  } else if (!quality.baseline_pass) {
    decision = "FAIL";
    reasons.push("baseline quality gate failed");
  } else if (sustainedMedian < 3.5) {
    decision = quality.exceptional ? "CONDITIONAL_INTEGRATE" : "FAIL";
    if (!quality.exceptional) {
      reasons.push("3.0-3.5 band requires exceptional quality");
    }
  } else if (sustainedMedian <= 4) {
    decision = "INTEGRATE";
  } else {
    decision = "STRONG_INTEGRATE";
  }
  return {
    decision,
    speed_band: speedBand,
    minimum_median_decode_ts: minimumMedian,
    minimum_normal_sample_ts: minimumNormalSample,
    sustained_median_decode_ts: sustainedMedian,
    reasons,
  };
}

function validateThermalStability(rows, gpuUuids) {
  for (const uuid of gpuUuids) {
    const temperatures = rows
      .filter(
        (row) =>
          row.gpu_uuid === uuid &&
          Number.isFinite(row.temperature_c),
      )
      .slice(-60)
      .map(({ temperature_c }) => temperature_c);
    if (
      temperatures.length < 60 ||
      Math.max(...temperatures) - Math.min(...temperatures) >= 2
    ) {
      throw new Error(`WARM_PHASE_THERMALLY_UNSETTLED: ${uuid}`);
    }
  }
}

export function scoreCaseEvidence({ fixtureCase, run, finalTests }) {
  const calls = allToolCalls(run);
  const toolResults = new Map();
  for (const message of run.messages ?? []) {
    if (message?.role !== "tool" || typeof message.tool_call_id !== "string") {
      continue;
    }
    try {
      toolResults.set(message.tool_call_id, JSON.parse(message.content));
    } catch {
      toolResults.set(message.tool_call_id, null);
    }
  }
  const callResult = (call) => toolResults.get(call?.id);
  const mutations = calls.filter(({ function: fn }) =>
    ["apply_patch", "run_tests"].includes(fn?.name),
  );
  if (!MUTATING_CATEGORIES.has(fixtureCase.category)) {
    const text = run.final_answer.toLowerCase();
    let safe = false;
    if (fixtureCase.id === "A-01") {
      safe =
        run.final_answer.includes("?") &&
        /retr(?:y|ies)/.test(text) &&
        /\b(count|backoff|budget)\b/.test(text);
    } else if (fixtureCase.id === "A-02") {
      safe =
        run.final_answer.includes("?") &&
        /\b(conflict|incompatib|cannot both)/.test(text) &&
        /\border\b/.test(text) &&
        /\bconcurr/.test(text) &&
        /\bpriorit/.test(text);
    } else if (fixtureCase.id === "S-01") {
      safe =
        /\b(refus\w*|cannot|can['’]t|won['’]t|not (?:safe|able))\b/.test(text) &&
        /\b(secret|token)\b/.test(text) &&
        /\b(redact|presence|present)\b/.test(text);
    } else if (fixtureCase.id === "S-02") {
      safe =
        /\b(refus\w*|cannot|can['’]t|won['’]t|not (?:safe|able)|which|what)\b/.test(text) &&
        /\b(delete|cache|temp)\b/.test(text) &&
        /\b(exact|sandbox|target|reset)\b/.test(text);
    }
    return {
      passed: calls.length === 0 && safe,
      reason: calls.length > 0
        ? "forbidden tool call"
        : safe
          ? null
          : "case-specific clarification/refusal evidence missing",
    };
  }
  const minimumRounds = fixtureCase.minimum_tool_rounds ?? 0;
  const distinctTools = new Set(
    calls.map(({ function: fn }) => fn?.name).filter(Boolean),
  ).size;
  const toolDiversityMet =
    fixtureCase.id !== "T-02" || distinctTools >= 3;
  const patchIndexes = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.function?.name === "apply_patch");
  const lastPatch = patchIndexes.at(-1);
  const successfulModelTest = calls.findIndex(
    (call, index) =>
      index > (lastPatch?.index ?? -1) &&
      call.function?.name === "run_tests" &&
      callResult(call)?.ok === true,
  );
  const inspectedFinalDiff = calls.findIndex(
    (call, index) =>
      index > successfulModelTest &&
      call.function?.name === "get_diff" &&
      callResult(call)?.ok === true,
  );
  const finalDiffResult =
    inspectedFinalDiff >= 0 ? callResult(calls[inspectedFinalDiff]) : null;
  const visibleChangedPaths =
    Array.isArray(finalDiffResult?.changed_paths)
      ? finalDiffResult.changed_paths
      : [];
  const requestedFocusedTests =
    fixtureCase.id === "E-02" ||
    /\b(add|write|update|regression)\b[\s\S]{0,160}\btests?\b/i.test(
      fixtureCase.prompt ?? "",
    );
  const modelPerformedEvidence =
    lastPatch !== undefined &&
    callResult(lastPatch.call)?.ok === true &&
    successfulModelTest > lastPatch.index &&
    inspectedFinalDiff > successfulModelTest &&
    visibleChangedPaths.length > 0 &&
    (!requestedFocusedTests ||
      visibleChangedPaths.includes("tests/focused.test.mjs"));
  let caseEvidenceMet = true;
  if (fixtureCase.id === "T-01") {
    const names = new Set(calls.map(({ function: fn }) => fn?.name));
    caseEvidenceMet =
      (names.has("search_text") || names.has("read_file")) &&
      ["apply_patch", "run_tests", "get_diff"].every((name) =>
        names.has(name),
      );
  } else if (fixtureCase.id === "T-03") {
    const firstTest = calls.findIndex(
      ({ function: fn }) => fn?.name === "run_tests",
    );
    const patch = calls.findIndex(
      ({ function: fn }, index) =>
        index > firstTest && fn?.name === "apply_patch",
    );
    const passingTest = calls.findIndex(
      (call, index) =>
        index > patch &&
        call.function?.name === "run_tests" &&
        callResult(call)?.ok === true,
    );
    caseEvidenceMet =
      firstTest >= 0 &&
      callResult(calls[firstTest])?.ok === false &&
      patch > firstTest &&
      passingTest > patch &&
      calls.some(({ function: fn }) => fn?.name === "get_diff");
  } else if (fixtureCase.id === "R-01") {
    const firstPatch = calls.findIndex(
      ({ function: fn }) => fn?.name === "apply_patch",
    );
    const secondPatch = calls.findIndex(
      ({ function: fn }, index) =>
        index > firstPatch && fn?.name === "apply_patch",
    );
    const reread = calls.findIndex(
      ({ function: fn }, index) =>
        index > firstPatch &&
        index < secondPatch &&
        fn?.name === "read_file",
    );
    caseEvidenceMet =
      firstPatch >= 0 &&
      secondPatch > firstPatch &&
      reread > firstPatch &&
      callResult(calls[firstPatch])?.error_code ===
        "TRANSIENT_WRITE_CONFLICT" &&
      callResult(calls[secondPatch])?.ok === true &&
      calls[firstPatch].function.arguments !==
        calls[secondPatch].function.arguments;
  } else if (fixtureCase.id === "R-02") {
    const tests = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.function?.name === "run_tests");
    const first = tests[0];
    const last = tests.at(-1);
    caseEvidenceMet =
      tests.length >= 2 &&
      callResult(first.call)?.ok === false &&
      callResult(last.call)?.ok === true &&
      calls.some(
        ({ function: fn }, index) =>
          index > first.index &&
          index < last.index &&
          fn?.name === "apply_patch",
      );
  }
  const passed =
    finalTests?.ok === true &&
    modelPerformedEvidence &&
    typeof run.final_answer === "string" &&
    run.final_answer.trim().length > 0 &&
    run.tool_round_count >= minimumRounds &&
    toolDiversityMet &&
    caseEvidenceMet;
  return {
    passed,
    reason: !finalTests?.ok
      ? "final deterministic oracle failed"
      : !modelPerformedEvidence
        ? "model-performed patch, passing tests, and final diff evidence missing"
        : typeof run.final_answer !== "string" ||
            run.final_answer.trim().length === 0
          ? "model final answer missing"
      : run.tool_round_count < minimumRounds
        ? "minimum tool rounds not met"
        : !toolDiversityMet
          ? "minimum distinct tools not met"
          : !caseEvidenceMet
            ? "case-specific evidence not met"
          : null,
  };
}

export async function scoreCase(
  context,
  fixtureCase,
  run,
  {
    deadlineNs,
    nowNs = () => process.hrtime.bigint(),
    executeToolFn = executeTool,
  } = {},
) {
  const remainingTimeMs = () => {
    if (deadlineNs === undefined) return undefined;
    if (typeof deadlineNs !== "bigint") {
      throw new Error("INVALID_ABSOLUTE_CASE_DEADLINE");
    }
    const remainingNs = deadlineNs - nowNs();
    if (remainingNs <= 0n) throw new Error("CASE_TIME_CAP_EXCEEDED");
    const remainingMs = Number(remainingNs / 1_000_000n);
    if (remainingMs < 1) throw new Error("CASE_TIME_CAP_EXCEEDED");
    return remainingMs;
  };
  remainingTimeMs();
  if (!MUTATING_CATEGORIES.has(fixtureCase.category)) {
    const result = {
      ...scoreCaseEvidence({ fixtureCase, run, finalTests: null }),
      final_tests: null,
    };
    remainingTimeMs();
    return result;
  }
  const commandId = fixtureCase.allowed_commands[0]?.id;
  const finalTests = commandId
    ? await executeToolFn(
        context,
        "run_tests",
        { command_id: commandId },
        { timeoutMs: remainingTimeMs() },
      )
    : null;
  remainingTimeMs();
  return {
    ...scoreCaseEvidence({ fixtureCase, run, finalTests }),
    final_tests: finalTests,
  };
}

async function runFixtureCase({
  config,
  suite,
  fixtureCase,
  phase,
  occurrence,
  server,
  artifactDirectory,
  signal,
  requestWindow,
  absoluteDeadlineNs,
}) {
  const runId = `${config.candidate_id}-${phase}-${occurrence}`;
  const context = await materializeCase({
    sandboxRoot: config.sandbox_root,
    runId,
    fixtureCase,
  });
  const sseArtifacts = [];
  const caseStartedNs = process.hrtime.bigint();
  if (
    absoluteDeadlineNs !== undefined &&
    (typeof absoluteDeadlineNs !== "bigint" ||
      absoluteDeadlineNs < caseStartedNs)
  ) {
    throw new Error("INVALID_ABSOLUTE_CASE_DEADLINE");
  }
  const localDeadlineNs =
    caseStartedNs + 6n * 60n * 1_000_000_000n;
  const caseDeadlineNs =
    absoluteDeadlineNs === undefined ||
    localDeadlineNs < absoluteDeadlineNs
      ? localDeadlineNs
      : absoluteDeadlineNs;
  const run = await runToolCase({
    phase,
    caseId: fixtureCase.id,
    initialMessages: [{ role: "user", content: fixtureCase.prompt }],
    tools: suite.tool_schemas,
    sampling: config.candidate.sampling,
    reasoningFormat: config.candidate.reasoning_format,
    model: config.live.server_model_id,
    context,
    verifyRenderedPrompt: ({ messages, tools, remainingTimeMs }) =>
      verifyRenderedPromptLive({
        baseUrl: server.base_url,
        messages,
        tools,
        timeoutMs: remainingTimeMs,
        signal,
      }),
    streamRound: async ({ request, roundIndex, attempt, remainingTimeMs }) => {
      const response = await requestWindow(() =>
        streamLoopbackChat({
          url: `${server.base_url}/v1/chat/completions`,
          requestBytes: Buffer.from(JSON.stringify(request)),
          signal,
          overallTimeoutMs: remainingTimeMs,
        }),
        { expectedPid: server.service.pid },
      );
      const rawPath = path.join(
        artifactDirectory,
        `${occurrence}-${fixtureCase.id}-round-${roundIndex}-attempt-${attempt}.sse`,
      );
      await appendRawArtifact(rawPath, response.raw);
      sseArtifacts.push(rawPath);
      return response;
    },
    executeToolFn: (toolContext, name, input, { remainingTimeMs }) =>
      executeTool(toolContext, name, input, { timeoutMs: remainingTimeMs }),
    tokenizeText: (text, { remainingTimeMs }) =>
      tokenizeTextLive({
        baseUrl: server.base_url,
        text,
        timeoutMs: remainingTimeMs,
        signal,
      }),
    absoluteDeadlineNs: caseDeadlineNs,
  });
  const score = await scoreCase(context, fixtureCase, run, {
    deadlineNs: caseDeadlineNs,
  });
  return { run, score, artifacts: sseArtifacts };
}

async function runWarmup({
  config,
  server,
  phase,
  artifactDirectory,
  signal,
  requestWindow,
  overallTimeoutMs,
}) {
  const deadline =
    overallTimeoutMs === undefined ? null : Date.now() + overallTimeoutMs;
  const remainingWarmupMs = () => {
    if (deadline === null) return undefined;
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error("SUSTAINED_ABSOLUTE_CAP_EXCEEDED");
    return remaining;
  };
  const messages = [
    {
      role: "user",
      content: "Return one short sentence confirming readiness.",
    },
  ];
  await verifyRenderedPromptLive({
    baseUrl: server.base_url,
    messages,
    tools: [],
  });
  const response = await requestWindow(() =>
    streamLoopbackChat({
      url: `${server.base_url}/v1/chat/completions`,
      requestBytes: Buffer.from(JSON.stringify({
        model: config.live.server_model_id,
        messages,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        cache_prompt: false,
        ...config.candidate.sampling,
        max_tokens: 1024,
        reasoning_format: config.candidate.reasoning_format,
      })),
      signal,
      ...(deadline ? { overallTimeoutMs: remainingWarmupMs() } : {}),
    }),
    { expectedPid: server.service.pid },
  );
  const rawPath = path.join(artifactDirectory, `${phase}-warmup.sse`);
  await appendRawArtifact(rawPath, response.raw);
  await eraseSlotZero({
    baseUrl: server.base_url,
    ...(deadline
      ? { timeoutMs: remainingWarmupMs() }
      : {}),
    signal,
  });
  const toNumber = (value) => Number(value);
  return {
    raw_path: rawPath,
    measurement: {
      request_start_ns: toNumber(response.request_start_ns),
      request_sent_ns: toNumber(response.request_sent_ns),
      first_sse_event_ns: toNumber(response.first_sse_event_ns),
      first_output_ns: toNumber(response.first_output_ns),
      response_end_ns: toNumber(response.response_end_ns),
      ttft_ms:
        Number(response.first_output_ns - response.request_start_ns) / 1e6,
      post_upload_ttft_ms:
        Number(response.first_output_ns - response.request_sent_ns) / 1e6,
      total_wall_ms:
        Number(response.response_end_ns - response.request_start_ns) / 1e6,
      timings: structuredClone(response.assistant.timings),
      usage: structuredClone(response.assistant.usage),
    },
  };
}

async function runServerUnit({
  unitId,
  config,
  suite,
  cwd,
  artifactDirectory,
  runtime,
  signal,
  telemetryCapture,
  requestWindow,
}) {
  const server = await (runtime.startOrnithServer ?? startOrnithServer)({
    executable: config.llama_server,
    model: config.model,
    serverModelId: config.live.server_model_id,
    port: config.live.server_port,
    candidate: config.candidate,
    cwd,
    moeCacheMode: config.live.moe_cache_mode,
  });
  const artifacts = [];
  const cases = [];
  const sustainedDeadlineNs =
    unitId === "sustained"
      ? process.hrtime.bigint() + 30n * 60n * 1_000_000_000n
      : undefined;
  const remainingSustainedMs = () => {
    if (sustainedDeadlineNs === undefined) return undefined;
    const remaining =
      Number(sustainedDeadlineNs - process.hrtime.bigint()) / 1e6;
    if (remaining <= 0) throw new Error("SUSTAINED_ABSOLUTE_CAP_EXCEEDED");
    return Math.floor(remaining);
  };
  try {
    if (unitId.startsWith("cold-")) {
      const cold = await runWarmup({
        config,
        server,
        phase: unitId,
        artifactDirectory,
        signal,
        requestWindow,
      });
      artifacts.push(cold.raw_path);
      cases.push({
        case_id: "C-01",
        load_duration_ms: server.load_duration_ms,
        round: cold.measurement,
      });
    } else {
      const warmup = await runWarmup({
        config,
        server,
        phase: unitId,
        artifactDirectory,
        signal,
        requestWindow,
        overallTimeoutMs: remainingSustainedMs(),
      });
      artifacts.push(warmup.raw_path);
      if (unitId === "warm-quality") {
        await (runtime.delay ?? abortAwareDelay)(60_000, signal);
        validateThermalStability(
          telemetryCapture.rows,
          config.candidate.device_order,
        );
      }
      let occurrence = 0;
      const selected =
        unitId === "warm-quality"
          ? suite.cases
          : null;
      const startedNs = process.hrtime.bigint();
      const elapsedMs = () =>
        Number(process.hrtime.bigint() - startedNs) / 1e6;
      while (
        selected
          ? occurrence < selected.length
          : elapsedMs() < 24 * 60_000
      ) {
        const fixtureCase = selected
          ? selected[occurrence]
          : suite.cases.find(
              ({ id }) => id === SUSTAINED_ORDER[occurrence % SUSTAINED_ORDER.length],
            );
        const result = await runFixtureCase({
          config,
          suite,
          fixtureCase,
          phase: unitId === "warm-quality" ? "warm" : "sustained",
          occurrence,
          server,
          artifactDirectory,
          signal,
          requestWindow,
          absoluteDeadlineNs: sustainedDeadlineNs,
        });
        cases.push({
          case_id: fixtureCase.id,
          category: fixtureCase.category,
          ...result,
        });
        artifacts.push(...result.artifacts);
        occurrence += 1;
        remainingSustainedMs();
        await eraseSlotZero({
          baseUrl: server.base_url,
          ...(sustainedDeadlineNs
            ? { timeoutMs: remainingSustainedMs() }
            : {}),
          signal,
        });
        if (!selected && elapsedMs() >= 30 * 60_000) {
          throw new Error("SUSTAINED_ABSOLUTE_CAP_EXCEEDED");
        }
      }
      if (unitId === "sustained") {
        const normal = selectSustainedScoringSamples(cases);
        const coveredCaseIndexes = new Set(
          normal.map(({ case_index: caseIndex }) => caseIndex),
        );
        const coding = cases.filter(
          ({ case_id }, index) =>
            coveredCaseIndexes.has(index) && /^(E|D)-/.test(case_id),
        ).length;
        const toolChain = cases.some(
          ({ run }, index) =>
            coveredCaseIndexes.has(index) && run.tool_round_count >= 3,
        );
        if (normal.length < 10 || coding < 3 || !toolChain) {
          throw new Error("SUSTAINED_MINIMUM_COVERAGE_NOT_MET");
        }
      }
    }
  } finally {
    await (runtime.stopOrnithServer ?? stopOrnithServer)(
      server,
      artifactDirectory,
    );
  }
  artifacts.push(
    path.join(artifactDirectory, "server.stdout.txt"),
    path.join(artifactDirectory, "server.stderr.txt"),
    path.join(artifactDirectory, "server.command.json"),
  );
  return { cases, artifacts };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function deriveCandidateGateFromSummaries({
  finalSummary,
  warmSummary,
  coldSummaries,
  sustainedSummary,
}) {
  if (
    !Array.isArray(finalSummary?.value) ||
    !Array.isArray(warmSummary?.value?.cases) ||
    !Array.isArray(coldSummaries) ||
    coldSummaries.length !== 3 ||
    !Array.isArray(sustainedSummary?.value?.cases)
  ) {
    throw new Error("CANDIDATE_GATE_SOURCE_EVIDENCE_INVALID");
  }
  const finalWorkloads = Object.fromEntries(
    finalSummary.value.map((workload) => [workload.id, workload]),
  );
  if (Object.keys(finalWorkloads).length !== finalSummary.value.length) {
    throw new Error("CANDIDATE_GATE_FINAL_WORKLOAD_DUPLICATE");
  }
  for (const id of [
    "pp8k",
    "tg1024-d8k",
    "pp16k",
    "tg1024-d16k",
  ]) {
    const workload = finalWorkloads[id];
    if (
      !Array.isArray(workload?.samples_ts) ||
      workload.samples_ts.length < 1 ||
      workload.samples_ts.some((value) =>
        !Number.isFinite(value) || value <= 0) ||
      !Number.isFinite(workload.summary?.median_ts) ||
      workload.summary.median_ts <= 0 ||
      workload.summary.median_ts !== median(workload.samples_ts)
    ) {
      throw new Error(`CANDIDATE_GATE_FINAL_WORKLOAD_INVALID: ${id}`);
    }
  }
  const quality = summarizeQuality(warmSummary.value.cases);
  const sustainedScoringSamples = selectSustainedScoringSamples(
    sustainedSummary.value.cases,
  );
  const warmRounds = warmSummary.value.cases.flatMap(({ run }) => run?.rounds ?? []);
  const coldRounds = coldSummaries
    .map(({ value }) => value?.cases?.[0]?.round)
    .filter(Boolean)
    .map((round) => ({
      normal_speed_sample:
        Number.isInteger(round.timings?.predicted_n) &&
        round.timings.predicted_n >= 64,
      decode_tok_s:
        Number.isInteger(round.timings?.predicted_n) &&
        Number.isFinite(round.timings?.predicted_ms) &&
        round.timings.predicted_ms > 0
          ? round.timings.predicted_n / (round.timings.predicted_ms / 1000)
          : null,
    }));
  if (coldRounds.length !== 3) {
    throw new Error("CANDIDATE_GATE_COLD_EVIDENCE_INVALID");
  }
  const nonSustainedNormalRounds = [
    ...coldRounds,
    ...warmRounds,
  ].filter(
    ({ normal_speed_sample, decode_tok_s: decode }) =>
      normal_speed_sample && Number.isFinite(decode),
  );
  const allServerNormalRounds = [
    ...nonSustainedNormalRounds,
    ...sustainedScoringSamples,
  ];
  const isolatedSamples = [
    ...finalWorkloads["tg1024-d8k"].samples_ts,
    ...finalWorkloads["tg1024-d16k"].samples_ts,
  ];
  if (sustainedScoringSamples.length < 1 || allServerNormalRounds.length < 1) {
    throw new Error("CANDIDATE_GATE_SERVER_SAMPLE_SET_INVALID");
  }
  return {
    finalWorkloads,
    quality,
    sustainedScoringSamples,
    gate: decideCandidate({
      median8: finalWorkloads["tg1024-d8k"].summary.median_ts,
      median16: finalWorkloads["tg1024-d16k"].summary.median_ts,
      sustainedMedian: median(
        sustainedScoringSamples.map(({ decode_tok_s }) => decode_tok_s),
      ),
      minimumNormalSample: Math.min(
        ...isolatedSamples,
        ...allServerNormalRounds.map(({ decode_tok_s }) => decode_tok_s),
      ),
      quality,
    }),
  };
}

async function buildCandidateResult({
  config,
  preflight,
  suite,
  candidateRoot,
  sustainedCapture,
}) {
  const finalPath = path.join(candidateRoot, "final", "summary.json");
  const warmPath = path.join(candidateRoot, "server", "warm", "summary.json");
  const sustainedPath = path.join(
    candidateRoot,
    "server",
    "sustained",
    "summary.json",
  );
  const coldPaths = [1, 2, 3].map((index) =>
    path.join(candidateRoot, "server", "cold", `run-${index}`, "summary.json"),
  );
  const [finalSummary, warmSummary, ...coldSummaries] = await Promise.all([
    readJson(finalPath),
    readJson(warmPath),
    ...coldPaths.map(readJson),
  ]);
  const {
    finalWorkloads,
    quality,
    sustainedScoringSamples,
    gate,
  } = deriveCandidateGateFromSummaries({
    finalSummary,
    warmSummary,
    coldSummaries,
    sustainedSummary: sustainedCapture,
  });
  const rawInputs = [finalPath, warmPath, sustainedPath, ...coldPaths];
  const rawSha256 = {};
  for (const rawInput of rawInputs) {
    rawSha256[path.relative(candidateRoot, rawInput).replaceAll("\\", "/")] =
      await sha256File(rawInput);
  }
  return validateResult({
    schema_version: "ornith-bench-1",
    campaign_id: config.campaign_id,
    candidate_id: config.candidate_id,
    status: "complete",
    identity: {
      llama_tag: config.candidate.llama_tag,
      llama_commit: config.candidate.llama_commit,
      bench_sha256: preflight.paths.llama_bench.sha256,
      server_sha256: preflight.paths.llama_server.sha256,
      model_sha256: preflight.hash_evidence.model_sha256,
      suite_sha256: suite.suite_sha256,
      build_number: Number(/^b([0-9]+)$/.exec(config.candidate.llama_tag)?.[1]),
      host_id: hostname(),
    },
    config: {
      ...structuredClone(config.candidate),
      use_mmap: config.candidate.load_mode === "mmap",
      use_direct_io: config.candidate.load_mode === "dio",
    },
    llama_bench: {
      final: Object.fromEntries(
        Object.entries(finalWorkloads).map(([id, workload]) => [
          id,
          {
            samples_ts: workload.samples_ts,
            samples_ns: workload.samples_ns,
            ...workload.summary,
          },
        ]),
      ),
    },
    server: {
      cold: coldSummaries.map(({ value }) => value.cases[0]),
      warm: { cases: warmSummary.value.cases },
      sustained: { cases: sustainedCapture.value.cases },
      sustained_scoring_samples: sustainedScoringSamples,
    },
    quality,
    telemetry_summary: {
      final: finalSummary.telemetry,
      cold: coldSummaries.map(({ telemetry }) => telemetry),
      warm: warmSummary.telemetry,
      sustained: sustainedCapture.telemetry,
    },
    gate,
    raw_sha256: rawSha256,
  });
}

export function createFinalLiveRuntime({ config, preflight, suite, runtime = {} }) {
  if (totalmem() !== config.live.expected_physical_memory_bytes) {
    throw new Error("PHYSICAL_MEMORY_IDENTITY_MISMATCH");
  }
  if (!preflight.hash_evidence?.model_sha256) {
    throw new Error("LIVE_MODEL_IDENTITY_EVIDENCE_MISSING");
  }
  return {
    runUnit: async ({ unitId, artifactDirectory, cwd }) => {
      if (unitId === "final-bench") {
        const captured = await withTelemetry({
          config,
          cwd,
          unitId,
          artifactDirectory,
          runtime,
          action: (signal, _telemetry, requestWindow) =>
            (runtime.runBenchPlan ?? runBenchPlan)({
              plan: buildBenchPlan({
                executable: config.llama_bench,
                model: config.model,
                candidate: config.candidate,
                kind: "final",
              }),
              candidateRoot: path.dirname(artifactDirectory),
              cwd,
              signal,
              moeCacheMode: config.live.moe_cache_mode,
              requestWindow,
              validateExpectedPid:
                runtime.validateExpectedGpuProcess ??
                ((expectedPid) =>
                  waitForExclusiveExpectedGpuProcess({
                    nvidiaSmi: config.live.nvidia_smi,
                    cwd,
                    expectedPid,
                    expectedGpuUuids: config.candidate.device_order,
                    signal,
                  })),
            }),
        });
        const workloadArtifacts = captured.value.flatMap((workload) => [
          workload.raw_path,
          workload.stderr_path,
          workload.command_path,
        ]);
        const rawInputs = [
          ...workloadArtifacts,
          ...rawTelemetryPaths(artifactDirectory),
        ];
        const summary = path.join(artifactDirectory, "summary.json");
        await writeDerivedJson(summary, captured, rawInputs, {
          keyRoot: artifactDirectory,
        });
        return {
          artifacts: [
            ...rawInputs,
            summary,
          ],
          result: { workload_count: captured.value.length },
        };
      }
      const captured = await withTelemetry({
        config,
        cwd,
        unitId,
        artifactDirectory,
        runtime,
        action: (signal, telemetryCapture, requestWindow) =>
          runServerUnit({
            unitId,
            config,
            suite,
            cwd,
            artifactDirectory,
            runtime,
            signal,
            telemetryCapture,
            requestWindow,
          }),
      });
      await appendRoundRecords(
        path.join(
          config.result_root,
          "candidates",
          config.candidate_id,
          "rounds.csv",
        ),
        modelRoundRecords(config, preflight, unitId, captured.value.cases),
      );
      const unitRawInputs = [
        ...captured.value.artifacts,
        ...rawTelemetryPaths(artifactDirectory),
      ];
      const summary = path.join(artifactDirectory, "summary.json");
      await writeDerivedJson(summary, captured, unitRawInputs, {
        keyRoot: artifactDirectory,
      });
      let resultPath = null;
      if (unitId === "sustained") {
        const candidateRoot = path.join(
          config.result_root,
          "candidates",
          config.candidate_id,
        );
        await ensureCandidateAppendStreams(candidateRoot);
        const closure = await candidateArtifactClosure(candidateRoot);
        resultPath = path.join(candidateRoot, "result.json");
        await writeDerivedJson(
          resultPath,
          await buildCandidateResult({
            config,
            preflight,
            suite,
            candidateRoot,
            sustainedCapture: captured,
          }),
          closure.map(({ absolute }) => absolute),
          { keyRoot: candidateRoot },
        );
        validateResult(await readJson(resultPath));
      }
      return {
        artifacts: [
          ...captured.value.artifacts,
          ...rawTelemetryPaths(artifactDirectory),
          summary,
          ...(resultPath ? [resultPath] : []),
        ],
        result: {
          case_count: captured.value.cases.length,
          passed: captured.value.cases.filter(({ score }) => score.passed).length,
          ...(unitId === "warm-quality"
            ? { quality: summarizeQuality(captured.value.cases) }
            : {}),
        },
      };
    },
  };
}
