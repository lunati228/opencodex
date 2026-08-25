import path from "node:path";

import {
  TELEMETRY_CSV_HEADER,
  appendCsvRecords,
  appendRawArtifact,
} from "./artifacts.mjs";
import { startPinnedService, stopPinnedService } from "./service-process.mjs";
import {
  buildDmonArgv,
  buildHostMonitorArgv,
  buildNvidiaQueryArgv,
  createDmonIdentityTracker,
  createTelemetryWatchdog,
  enforceDmonSafety,
  createHostSafetyState,
  updateHostSafety,
  parseDmonDataLine,
  parseNvidiaCsvRow,
  parseTypeperfSample,
  recordDmonGpuSample,
  summarizeTelemetryRows,
  updateThermalSafety,
  validateExpectedGpuMapping,
  validateGpuSampleIdentity,
  validateObservedGpuSet,
  validatePerGpuCoverage,
  validateTelemetryCoverage,
  validateTelemetryStreams,
} from "./telemetry-live.mjs";

const MAX_PARSER_PENDING_BYTES = 1024 * 1024;

function lineConsumer(callback, onError) {
  let pending = Buffer.alloc(0);
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    pending = Buffer.alloc(0);
    onError(error);
  };
  const accept = (bytes) => {
    let line = bytes;
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (line.toString("utf8").trim()) callback(line.toString("utf8"));
  };
  return {
    push(chunk) {
      if (failed) return;
      const bytes = Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length && !failed) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        const combinedLength = pending.length + segment.length;
        if (combinedLength > MAX_PARSER_PENDING_BYTES) {
          const error = new Error("TELEMETRY_LINE_BUFFER_OVERFLOW");
          error.code = "TELEMETRY_LINE_BUFFER_OVERFLOW";
          fail(error);
          return;
        }
        if (newline < 0) {
          pending =
            pending.length === 0
              ? Buffer.from(segment)
              : Buffer.concat([pending, segment], combinedLength);
          return;
        }
        try {
          accept(
            pending.length === 0
              ? segment
              : Buffer.concat([pending, segment], combinedLength),
          );
        } catch (error) {
          fail(error);
          return;
        }
        pending = Buffer.alloc(0);
        offset = newline + 1;
      }
    },
    finish() {
      if (failed) return;
      if (pending.length > 0) {
        try {
          accept(pending);
        } catch (error) {
          fail(error);
        }
      }
      pending = Buffer.alloc(0);
    },
  };
}

function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? String(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const TELEMETRY_FIELDS = [
  "schema_version", "campaign_id", "run_id", "candidate_id", "phase",
  "timestamp_utc", "monotonic_ns", "gpu_uuid", "pci_bus_id", "temperature_c",
  "power_w", "sm_clock_mhz", "mem_clock_mhz", "vram_used_mib", "vram_total_mib",
  "gpu_util_pct", "mem_util_pct", "pcie_gen_current", "pcie_width_current",
  "pcie_rx_mb_s", "pcie_tx_mb_s", "thermal_throttle", "power_throttle",
  "ecc_or_replay_error", "request_in_flight",
];

export async function startTelemetryCapture({
  nvidiaSmi,
  hostMonitor,
  cwd,
  metadata,
  abortTemperatureC,
  abortController,
  requestInFlight = () => false,
  expectedGpuMapping,
  expectedPhysicalBytes,
  maximumGapMs,
  hostSafetyLimits,
  watchdogRuntime,
  serviceRuntime,
}) {
  const startService =
    serviceRuntime?.startPinnedService ?? startPinnedService;
  const stopService =
    serviceRuntime?.stopPinnedService ?? stopPinnedService;
  const rows = [];
  const clocks = [];
  const thermalCounts = new Map();
  const hostSafetyState = createHostSafetyState(hostSafetyLimits);
  const seenGpuUuids = new Set();
  const dmonClocks = [];
  const hostClocks = [];
  const dmonSamples = [];
  const hostSamples = [];
  let hostHeader = null;
  let fatalError = null;
  let stopping = false;
  const captureStartedNs = process.hrtime.bigint();
  const validatedGpuMapping = validateExpectedGpuMapping(expectedGpuMapping);
  const dmonIdentityTracker =
    createDmonIdentityTracker(validatedGpuMapping);
  const gpuClocks = new Map(
    validatedGpuMapping.map(({ gpu_uuid }) => [gpu_uuid, []]),
  );
  const onParseError = (error) => {
    fatalError ??= error;
    abortController.abort(error);
  };
  const watchdog = createTelemetryWatchdog({
    ...watchdogRuntime,
    keys: [
      "stream:query",
      "stream:dmon",
      "stream:host",
      ...validatedGpuMapping.flatMap(({ gpu_uuid: uuid }) => [
        `query:${uuid}`,
        `dmon:${uuid}`,
      ]),
    ],
    maximumGapMs,
    onStale: onParseError,
  });
  const queryLines = lineConsumer((line) => {
    const parsed = parseNvidiaCsvRow(line);
    validateGpuSampleIdentity(validatedGpuMapping, parsed);
    seenGpuUuids.add(parsed.gpu_uuid);
    const monotonicNs = process.hrtime.bigint();
    updateThermalSafety(thermalCounts, parsed, abortTemperatureC);
    watchdog.touch("stream:query");
    watchdog.touch(`query:${parsed.gpu_uuid}`);
    clocks.push(monotonicNs);
    gpuClocks.get(parsed.gpu_uuid).push(monotonicNs);
    rows.push({
      schema_version: "ornith-bench-1",
      ...metadata,
      timestamp_utc: new Date().toISOString(),
      monotonic_ns: monotonicNs.toString(),
      gpu_uuid: parsed.gpu_uuid,
      pci_bus_id: parsed.pci_bus_id,
      temperature_c: parsed.temperature_c,
      power_w: parsed.power_w,
      sm_clock_mhz: parsed.sm_clock_mhz,
      mem_clock_mhz: parsed.mem_clock_mhz,
      vram_used_mib: parsed.vram_used_mib,
      vram_total_mib: parsed.vram_total_mib,
      gpu_util_pct: parsed.gpu_util_pct,
      mem_util_pct: parsed.mem_util_pct,
      pcie_gen_current: parsed.pcie_gen_current,
      pcie_width_current: parsed.pcie_width_current,
      pcie_rx_mb_s: null,
      pcie_tx_mb_s: null,
      thermal_throttle: null,
      power_throttle: null,
      ecc_or_replay_error: null,
      request_in_flight: Boolean(requestInFlight()),
    });
  }, onParseError);
  const dmonLines = lineConsumer((line) => {
    const parsed = parseDmonDataLine(line);
    if (!parsed) return;
    const monotonicNs = process.hrtime.bigint();
    const bound = recordDmonGpuSample(
      dmonIdentityTracker,
      parsed,
      monotonicNs,
    );
    watchdog.touch("stream:dmon");
    watchdog.touch(`dmon:${bound.gpu_uuid}`);
    dmonClocks.push(monotonicNs);
    dmonSamples.push(bound);
    enforceDmonSafety(bound);
  }, onParseError);
  const hostLines = lineConsumer((line) => {
    if (hostHeader === null) {
      hostHeader = line;
      return;
    }
    const parsed = parseTypeperfSample(
      hostHeader,
      line,
      expectedPhysicalBytes,
    );
    watchdog.touch("stream:host");
    hostClocks.push(process.hrtime.bigint());
    hostSamples.push(parsed);
    updateHostSafety(hostSafetyState, parsed);
  }, onParseError);
  const started = [];
  try {
    const query = await startService({
      executable: nvidiaSmi,
      args: buildNvidiaQueryArgv(),
      cwd,
      onStdout: (chunk) => queryLines.push(chunk),
    });
    started.push(query);
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }
    const dmon = await startService({
      executable: nvidiaSmi,
      args: buildDmonArgv(),
      cwd,
      onStdout: (chunk) => dmonLines.push(chunk),
    });
    started.push(dmon);
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }
    const host = await startService({
      executable: hostMonitor,
      args: buildHostMonitorArgv(),
      cwd,
      onStdout: (chunk) => hostLines.push(chunk),
    });
    started.push(host);
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }
    for (const [name, service] of [
      ["query", query],
      ["dmon", dmon],
      ["host", host],
    ]) {
      service.wait().then(() => {
        if (!stopping) {
          const error = new Error(
            `TELEMETRY_PROCESS_EXITED_UNEXPECTEDLY: ${name}`,
          );
          fatalError ??= error;
          abortController.abort(error);
        }
      });
    }
    return {
      query,
      dmon,
      host,
      queryLines,
      rows,
      clocks,
      gpuClocks,
      dmonClocks,
      hostClocks,
      dmonSamples,
      dmonIdentityTracker,
      hostSamples,
      seenGpuUuids,
      expectedGpuMapping: validatedGpuMapping,
      metadata,
      captureStartedNs,
      fatalError: () => fatalError,
      markStopping: () => {
        stopping = true;
        watchdog.stop();
      },
      dmonLines,
      hostLines,
      stopService,
    };
  } catch (error) {
    watchdog.stop();
    await Promise.all(started.map((service) => stopService(service)));
    throw error;
  }
}

export async function stopTelemetryCapture(capture, {
  candidateRoot,
  rawDirectory,
}) {
  const stopRequestedNs = process.hrtime.bigint();
  const exitedBeforeStop = {
    query: Boolean(capture.query.closed()),
    dmon: Boolean(capture.dmon.closed()),
    host: Boolean(capture.host.closed()),
  };
  capture.markStopping();
  const stopService = capture.stopService ?? stopPinnedService;
  const exitResults = await Promise.allSettled([
    stopService(capture.query),
    stopService(capture.dmon),
    stopService(capture.host),
  ]);
  const exits = exitResults
    .filter(({ status }) => status === "fulfilled")
    .map(({ value }) => value);
  capture.queryLines.finish();
  capture.dmonLines.finish();
  capture.hostLines.finish();
  const queryCapture = capture.query.capture();
  const dmonCapture = capture.dmon.capture();
  const hostCapture = capture.host.capture();
  let validationError = capture.fatalError()
    ? new Error(`TELEMETRY_FATAL: ${capture.fatalError().message}`)
    : null;
  const terminationFailure = exitResults.find(
    ({ status }) => status === "rejected",
  );
  if (terminationFailure) {
    validationError ??= new Error(
      `TELEMETRY_TERMINATION_FAILED: ${terminationFailure.reason?.message ?? "unknown"}`,
    );
  }
  try {
    validateTelemetryStreams({
      query: capture.clocks,
      dmon: capture.dmonClocks,
      host: capture.hostClocks,
      captureStartedNs: capture.captureStartedNs,
      stopRequestedNs,
      exitedBeforeStop,
    });
  } catch (error) {
    validationError ??= error;
  }
  try {
    validatePerGpuCoverage({
      mapping: capture.expectedGpuMapping,
      clocksByUuid: capture.gpuClocks,
      captureStartedNs: capture.captureStartedNs,
      stopRequestedNs,
      monitorExitedEarly: exitedBeforeStop.query,
    });
  } catch (error) {
    validationError ??= error;
  }
  try {
    validatePerGpuCoverage({
      mapping: capture.expectedGpuMapping,
      clocksByUuid: capture.dmonIdentityTracker.clocksByUuid,
      captureStartedNs: capture.captureStartedNs,
      stopRequestedNs,
      monitorExitedEarly: exitedBeforeStop.dmon,
    });
  } catch (error) {
    validationError ??= new Error(
      `DMON_GPU_TELEMETRY_INVALID: ${error.message}`,
    );
  }
  try {
    validateObservedGpuSet(
      capture.expectedGpuMapping,
      capture.seenGpuUuids,
    );
  } catch (error) {
    validationError ??= error;
  }
  if (
    queryCapture.stdout_truncated || queryCapture.stderr_truncated ||
    dmonCapture.stdout_truncated || dmonCapture.stderr_truncated ||
    hostCapture.stdout_truncated || hostCapture.stderr_truncated
  ) {
    validationError ??= new Error("TELEMETRY_OUTPUT_TRUNCATED");
  }
  await Promise.all([
    appendRawArtifact(path.join(rawDirectory, "nvidia-query.stdout.csv"), queryCapture.stdout),
    appendRawArtifact(path.join(rawDirectory, "nvidia-query.stderr.txt"), queryCapture.stderr),
    appendRawArtifact(path.join(rawDirectory, "nvidia-dmon.stdout.txt"), dmonCapture.stdout),
    appendRawArtifact(path.join(rawDirectory, "nvidia-dmon.stderr.txt"), dmonCapture.stderr),
    appendRawArtifact(path.join(rawDirectory, "host-monitor.stdout.csv"), hostCapture.stdout),
    appendRawArtifact(path.join(rawDirectory, "host-monitor.stderr.txt"), hostCapture.stderr),
  ]);
  const csv = capture.rows
    .map((row) => TELEMETRY_FIELDS.map((field) => csvField(row[field])).join(","))
    .join("\n");
  if (csv.length > 0) {
    await appendCsvRecords(
      path.join(candidateRoot, "telemetry.csv"),
      TELEMETRY_CSV_HEADER,
      `${csv}\n`,
    );
  }
  if (validationError) throw validationError;
  const dmonByGpu = {};
  for (const { gpu_uuid: uuid } of capture.expectedGpuMapping) {
    const samples = capture.dmonSamples.filter(
      ({ gpu_uuid: sampleUuid }) => sampleUuid === uuid,
    );
    const percentile95 = (name) => {
      const values = samples
        .map((row) => row[name])
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
      return values.length > 0
        ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]
        : null;
    };
    dmonByGpu[uuid] = {
      samples: samples.length,
      pcie_rx_mb_s_p95: percentile95("rxpci"),
      pcie_tx_mb_s_p95: percentile95("txpci"),
      power_violation_observed: samples.some((row) => (row.pviol ?? 0) > 0),
      thermal_violation_observed: samples.some((row) => (row.tviol ?? 0) > 0),
    };
  }
  return {
    samples: capture.rows.length,
    maximum_gap_ms:
      capture.clocks.length >= 2
        ? validateTelemetryCoverage(capture.clocks).maximum_gap_ms
        : null,
    ...summarizeTelemetryRows(capture.rows),
    dmon_summary: {
      samples: capture.dmonSamples.length,
      pci_error_seen: capture.dmonSamples.some((row) => (row.pci ?? 0) > 0),
      ecc_error_seen: capture.dmonSamples.some(
        (row) => (row.sbecc ?? 0) > 0 || (row.dbecc ?? 0) > 0,
      ),
      power_violation_observed: capture.dmonSamples.some(
        (row) => (row.pviol ?? 0) > 0,
      ),
      thermal_violation_observed: capture.dmonSamples.some(
        (row) => (row.tviol ?? 0) > 0,
      ),
      by_gpu: dmonByGpu,
    },
    host_summary: {
      samples: capture.hostSamples.length,
      committed_pct_max: Math.max(
        ...capture.hostSamples.map((row) => row.committed_pct),
      ),
      available_bytes_min: Math.min(
        ...capture.hostSamples.map((row) => row.available_bytes),
      ),
      pages_input_per_sec_max: Math.max(
        ...capture.hostSamples
          .map((row) => row.pages_input_per_sec)
          .filter((value) => value !== null),
        0,
      ),
      page_reads_per_sec_max: Math.max(
        ...capture.hostSamples
          .map((row) => row.page_reads_per_sec)
          .filter((value) => value !== null),
        0,
      ),
    },
  };
}
