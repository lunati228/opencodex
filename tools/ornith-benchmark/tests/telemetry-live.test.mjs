import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDmonArgv,
  buildHostMonitorArgv,
  buildNvidiaQueryArgv,
  createTelemetryWatchdog,
  createDmonIdentityTracker,
  enforceDmonSafety,
  createHostSafetyState,
  hostSafetyLimitsFromConfig,
  updateHostSafety,
  HOST_AVAILABLE_SUSTAINED_SAMPLES,
  parseDmonDataLine,
  parseNvidiaCsvRow,
  parseTypeperfSample,
  summarizeTelemetryRows,
  recordDmonGpuSample,
  updateThermalSafety,
  validateExpectedGpuMapping,
  validateGpuSampleIdentity,
  validateObservedGpuSet,
  validatePerGpuCoverage,
  validateTelemetryCoverage,
  validateTelemetrySession,
  validateTelemetryStreams,
} from "../src/telemetry-live.mjs";

test("telemetry command is fixed one-second UUID-bound CSV and unsupported values become null", () => {
  assert.deepEqual(buildNvidiaQueryArgv(), [
    "--query-gpu=timestamp,index,uuid,pci.bus_id,temperature.gpu,power.draw,clocks.sm,clocks.mem,memory.used,memory.total,utilization.gpu,utilization.memory,pcie.link.gen.current,pcie.link.width.current",
    "--format=csv,noheader,nounits",
    "-l",
    "1",
  ]);
  assert.deepEqual(buildDmonArgv(), ["dmon", "-s", "pucvmet", "-d", "1", "-o", "DT"]);
  assert.deepEqual(buildHostMonitorArgv(), [
    "\\Processor(_Total)\\% Processor Time",
    "\\Memory\\% Committed Bytes In Use",
    "\\PhysicalDisk(_Total)\\Disk Bytes/sec",
    "\\Memory\\Available Bytes",
    "\\Memory\\Pages Input/sec",
    "\\Memory\\Page Reads/sec",
    "-si",
    "1",
    "-sc",
    "86400",
  ]);
  assert.throws(() => buildHostMonitorArgv(1), /INVALID_HOST_MONITOR_SAMPLE_COUNT/);
  assert.throws(
    () => buildHostMonitorArgv(86_401),
    /INVALID_HOST_MONITOR_SAMPLE_COUNT/,
  );
  const row = parseNvidiaCsvRow("2026/07/24 12:00:00.000, 0, GPU-1, 00000000:01:00.0, 55, [N/A], 2100, 7000, 1000, 16000, 90, 50, 4, 16");
  assert.equal(row.gpu_uuid, "GPU-1");
  assert.equal(row.power_w, null);
  assert.equal(row.temperature_c, 55);
});

test("live watchdog aborts hung streams and a silent GPU while other samples remain fresh", () => {
  let nowNs = 0n;
  const failures = [];
  const scheduled = [];
  const watchdog = createTelemetryWatchdog({
    keys: [
      "stream:query",
      "stream:dmon",
      "stream:host",
      "query:GPU-A",
      "query:GPU-B",
      "dmon:GPU-A",
      "dmon:GPU-B",
    ],
    maximumGapMs: 5_000,
    nowNs: () => nowNs,
    setTimeoutFn: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    clearTimeoutFn: () => {},
    onStale: (error) => failures.push(error),
  });
  nowNs = 4_000_000_000n;
  for (const key of [
    "stream:query",
    "stream:dmon",
    "stream:host",
    "query:GPU-A",
    "dmon:GPU-A",
  ]) {
    watchdog.touch(key);
  }
  nowNs = 5_001_000_000n;
  watchdog.checkNow();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /TELEMETRY_WATCHDOG_STALE/);
  assert.deepEqual(failures[0].stale_keys, [
    "dmon:GPU-B",
    "query:GPU-B",
  ]);
  watchdog.stop();
});

test("live watchdog real timer reports a monitor with no first sample promptly", async () => {
  const startedAt = performance.now();
  const failure = await new Promise((resolve) => {
    createTelemetryWatchdog({
      keys: ["stream:host"],
      maximumGapMs: 30,
      onStale: resolve,
    });
  });
  assert.match(failure.message, /TELEMETRY_WATCHDOG_STALE/);
  assert.deepEqual(failure.stale_keys, ["stream:host"]);
  assert.ok(performance.now() - startedAt < 500);
});

test("host and dmon parsers expose hard-abort evidence without treating pviol alone as fatal", () => {
  const fullHeader =
    '"(PDH-CSV 4.0)","\\\\host\\processor(_total)\\% processor time","\\\\host\\memory\\% committed bytes in use","\\\\host\\physicaldisk(_total)\\disk bytes/sec","\\\\host\\memory\\available bytes","\\\\host\\memory\\pages input/sec","\\\\host\\memory\\page reads/sec"';
  const missingProcessorHeader =
    '"(PDH-CSV 4.0)","\\\\host\\memory\\% committed bytes in use","\\\\host\\physicaldisk(_total)\\disk bytes/sec","\\\\host\\memory\\available bytes","\\\\host\\memory\\pages input/sec","\\\\host\\memory\\page reads/sec"';
  const sample =
    '"07/24/2026 12:00:00.000","10","94","1000","2000000000","1","2"';
  const host = parseTypeperfSample(
    fullHeader,
    sample,
    10_000_000_000,
  );
  const nativeOmission = parseTypeperfSample(
    missingProcessorHeader,
    sample,
    10_000_000_000,
  );
  assert.deepEqual(nativeOmission, host);
  assert.equal(host.cpu_util_pct, 10);
  assert.equal(host.committed_pct, 94);
  assert.equal(host.disk_bytes_per_sec, 1000);
  assert.equal(host.available_fraction, 0.2);
  assert.throws(
    () =>
      parseTypeperfSample(
        missingProcessorHeader,
        '"07/24/2026 12:00:00.000","10","94","1000","2000000000","1"',
        10_000_000_000,
      ),
    /TYPEPERF_COLUMN_MISMATCH/,
  );
  const values = [
    0, 100, 55, "-", 90, 50, 0, 0, 0, 0, 7000, 2100, 100, 0, 15000,
    1000, 0, 0, 0, 0, 10, 20,
  ];
  const dmon = parseDmonDataLine(`2026/07/24 12:00:00 ${values.join(" ")}`);
  assert.equal(dmon.source_timestamp, "2026/07/24 12:00:00");
  assert.equal(dmon.pviol, 100);
  assert.equal(dmon.pci, 0);
  assert.equal(dmon.rxpci, 10);
  assert.doesNotThrow(() => enforceDmonSafety(dmon));
  assert.throws(
    () => enforceDmonSafety({ ...dmon, pci: 1 }),
    /DMON_PCI_OR_ECC_ERROR/,
  );
  assert.throws(
    () => enforceDmonSafety({ ...dmon, dbecc: 1 }),
    /DMON_PCI_OR_ECC_ERROR/,
  );
  assert.throws(
    () => enforceDmonSafety({ ...dmon, pci: -1 }),
    /DMON_PCI_OR_ECC_ERROR/,
  );
  assert.doesNotThrow(() => updateHostSafety(createHostSafetyState(), host));
  assert.doesNotThrow(
    () =>
      updateHostSafety(createHostSafetyState(), {
        ...host,
        available_fraction: 0.05,
      }),
  );
  assert.throws(
    () =>
      updateHostSafety(createHostSafetyState(), {
        ...host,
        committed_pct: 95,
      }),
    /HOST_COMMIT_ABORT/,
  );
  assert.throws(
    () => updateHostSafety(createHostSafetyState(), { ...host, available_fraction: null }),
    /HOST_AVAILABLE_MEMORY_UNAVAILABLE/,
  );
  assert.throws(
    () => updateHostSafety({}, host),
    /INVALID_HOST_SAFETY_STATE/,
  );
});

test("the host memory floor aborts only on sustained starvation, not a load transient", () => {
  const starved = {
    cpu_util_pct: 20,
    committed_pct: 72,
    disk_bytes_per_sec: 500_000_000,
    available_fraction: 0.0343,
    available_bytes: 1_172_619_264,
    pages_input_per_sec: 90_000,
    page_reads_per_sec: 8_000,
  };
  const healthy = { ...starved, available_fraction: 0.73 };

  // The observed mmap cold-load dip: 3.43% availability while llama.cpp
  // prefetches the mapped range. Anything short of the sustained window must
  // not abort the candidate.
  const transient = createHostSafetyState();
  for (let i = 0; i < HOST_AVAILABLE_SUSTAINED_SAMPLES - 1; i += 1) {
    assert.equal(updateHostSafety(transient, starved), i + 1);
  }
  assert.equal(updateHostSafety(transient, healthy), 0);

  // A single recovered sample resets the window; starvation must be
  // consecutive to count.
  for (let i = 0; i < HOST_AVAILABLE_SUSTAINED_SAMPLES - 1; i += 1) {
    updateHostSafety(transient, starved);
  }
  assert.equal(transient.consecutive_below_floor, HOST_AVAILABLE_SUSTAINED_SAMPLES - 1);

  // Genuine sustained starvation still fails closed at the same 5% floor.
  const sustained = createHostSafetyState();
  for (let i = 0; i < HOST_AVAILABLE_SUSTAINED_SAMPLES - 1; i += 1) {
    updateHostSafety(sustained, starved);
  }
  assert.throws(
    () => updateHostSafety(sustained, starved),
    /HOST_AVAILABLE_MEMORY_ABORT/,
  );

  // Committed memory remains an instantaneous abort with no grace window.
  assert.throws(
    () => updateHostSafety(createHostSafetyState(), { ...starved, committed_pct: 95 }),
    /HOST_COMMIT_ABORT/,
  );
});

test("the host reserve is operator-configurable in GiB and seconds", () => {
  const sample = {
    cpu_util_pct: 12,
    committed_pct: 40,
    disk_bytes_per_sec: 1_300_000_000,
    // 3 GiB available on a 32 GiB host: 9.4%, comfortably above the 5%
    // fraction floor, so only an absolute reserve can catch it.
    available_fraction: 0.094,
    available_bytes: 3 * 1024 ** 3,
    pages_input_per_sec: 90_000,
    page_reads_per_sec: 8_000,
  };

  // Defaults must be byte-for-byte the prior behaviour.
  const defaults = hostSafetyLimitsFromConfig(undefined);
  assert.equal(defaults.available_floor_fraction, 0.05);
  assert.equal(defaults.available_reserve_bytes, null);
  assert.equal(defaults.sustained_samples, HOST_AVAILABLE_SUSTAINED_SAMPLES);
  assert.equal(defaults.committed_abort_pct, 95);
  assert.doesNotThrow(() => updateHostSafety(createHostSafetyState(), sample));

  // Reserving 4 GiB makes the same sample a violation, and seconds map 1:1 to
  // samples because the host monitor runs at 1 Hz.
  const reserved = hostSafetyLimitsFromConfig({
    available_reserve_gib: 4,
    sustained_seconds: 3,
  });
  assert.equal(reserved.available_reserve_bytes, 4 * 1024 ** 3);
  assert.equal(reserved.sustained_samples, 3);
  const state = createHostSafetyState(reserved);
  assert.equal(updateHostSafety(state, sample), 1);
  assert.equal(updateHostSafety(state, sample), 2);
  assert.throws(
    () => updateHostSafety(state, sample),
    /HOST_AVAILABLE_MEMORY_ABORT/,
  );

  // A recovered sample resets the window under the reserve too.
  const recovering = createHostSafetyState(reserved);
  updateHostSafety(recovering, sample);
  assert.equal(
    updateHostSafety(recovering, { ...sample, available_bytes: 8 * 1024 ** 3 }),
    0,
  );

  // A reserve must not be silently satisfied by a sample that carries no
  // absolute byte count.
  const { available_bytes: _omitted, ...fractionOnly } = sample;
  assert.equal(
    updateHostSafety(createHostSafetyState(reserved), fractionOnly),
    1,
  );

  // A lowered commit threshold fires earlier than the 95% default.
  assert.throws(
    () =>
      updateHostSafety(
        createHostSafetyState(
          hostSafetyLimitsFromConfig({ committed_abort_pct: 35 }),
        ),
        sample,
      ),
    /HOST_COMMIT_ABORT/,
  );

  for (const bad of [
    { available_reserve_gib: 0 },
    { available_reserve_gib: -1 },
    { available_reserve_gib: 2048 },
    { sustained_seconds: 0 },
    { sustained_seconds: 1.5 },
    { committed_abort_pct: 0 },
    { committed_abort_pct: 101 },
    { available_floor_fraction: 1 },
  ]) {
    assert.throws(
      () => hostSafetyLimitsFromConfig(bad),
      /INVALID_HOST_/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => hostSafetyLimitsFromConfig([]), /INVALID_HOST_RESERVE/);
});

test("dmon rows bind exact GPU indices and reject unknown or duplicate cycle identities", () => {
  const mapping = [
    { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
    { backend_device: "CUDA1", gpu_index: 1, gpu_uuid: "GPU-B" },
  ];
  const tracker = createDmonIdentityTracker(mapping);
  const base = {
    source_timestamp: "2026/07/24 12:00:00",
    pwr: 100,
    pci: 0,
  };
  const first = recordDmonGpuSample(
    tracker,
    { ...base, gpu: 0 },
    250_000_000n,
  );
  const second = recordDmonGpuSample(
    tracker,
    { ...base, gpu: 1 },
    300_000_000n,
  );
  assert.equal(first.gpu_uuid, "GPU-A");
  assert.equal(first.backend_device, "CUDA0");
  assert.equal(second.gpu_uuid, "GPU-B");
  assert.throws(
    () =>
      recordDmonGpuSample(
        tracker,
        { ...base, gpu: 0 },
        350_000_000n,
      ),
    /DMON_DUPLICATE_GPU_IN_SAMPLE/,
  );
  assert.throws(
    () =>
      recordDmonGpuSample(
        tracker,
        {
          ...base,
          source_timestamp: "2026/07/24 12:00:01",
          gpu: 2,
        },
        1_250_000_000n,
      ),
    /DMON_GPU_IDENTITY_MAPPING_DRIFT/,
  );
  recordDmonGpuSample(
    tracker,
    {
      ...base,
      source_timestamp: "2026/07/24 12:00:01",
      gpu: 0,
    },
    1_250_000_000n,
  );
  recordDmonGpuSample(
    tracker,
    {
      ...base,
      source_timestamp: "2026/07/24 12:00:01",
      gpu: 1,
    },
    1_300_000_000n,
  );
  assert.deepEqual(tracker.clocksByUuid.get("GPU-A"), [
    250_000_000n,
    1_250_000_000n,
  ]);
  assert.deepEqual(tracker.clocksByUuid.get("GPU-B"), [
    300_000_000n,
    1_300_000_000n,
  ]);
  assert.deepEqual(
    Object.keys(
      validatePerGpuCoverage({
        mapping,
        clocksByUuid: tracker.clocksByUuid,
        captureStartedNs: 0n,
        stopRequestedNs: 1_500_000_000n,
        monitorExitedEarly: false,
      }),
    ),
    ["GPU-A", "GPU-B"],
  );
  const missing = createDmonIdentityTracker(mapping);
  recordDmonGpuSample(missing, { ...base, gpu: 0 }, 250_000_000n);
  recordDmonGpuSample(missing, { ...base, gpu: 1 }, 300_000_000n);
  recordDmonGpuSample(
    missing,
    {
      ...base,
      source_timestamp: "2026/07/24 12:00:01",
      gpu: 0,
    },
    1_250_000_000n,
  );
  assert.throws(
    () =>
      validatePerGpuCoverage({
        mapping,
        clocksByUuid: missing.clocksByUuid,
        captureStartedNs: 0n,
        stopRequestedNs: 1_500_000_000n,
        monitorExitedEarly: false,
      }),
    /GPU_TELEMETRY_COVERAGE_INVALID: GPU-B:INSUFFICIENT/,
  );
});

test("thermal abort requires five consecutive over-ceiling samples per UUID", () => {
  const counts = new Map();
  for (let sample = 1; sample <= 4; sample += 1) {
    assert.equal(
      updateThermalSafety(
        counts,
        { gpu_uuid: "GPU-A", temperature_c: 80 },
        80,
      ),
      sample,
    );
  }
  assert.throws(
    () =>
      updateThermalSafety(
        counts,
        { gpu_uuid: "GPU-A", temperature_c: 80 },
        80,
      ),
    /THERMAL_ABORT: GPU-A/,
  );
  assert.equal(
    updateThermalSafety(
      counts,
      { gpu_uuid: "GPU-B", temperature_c: 79 },
      80,
    ),
    0,
  );
  for (const temperature_c of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        updateThermalSafety(
          counts,
          { gpu_uuid: "GPU-A", temperature_c },
          80,
        ),
      /GPU_TEMPERATURE_UNAVAILABLE: GPU-A/,
    );
  }
});

test("GPU identity requires an exact unique backend-index-UUID mapping and observed set", () => {
  const mapping = [
    { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
    { backend_device: "CUDA1", gpu_index: 1, gpu_uuid: "GPU-B" },
  ];
  assert.deepEqual(validateExpectedGpuMapping(mapping), mapping);
  assert.equal(
    validateGpuSampleIdentity(mapping, {
      gpu_index: 1,
      gpu_uuid: "GPU-B",
    }).backend_device,
    "CUDA1",
  );
  for (const invalid of [
    [mapping[0], { ...mapping[1], gpu_uuid: "GPU-A" }],
    [mapping[0], { ...mapping[1], gpu_index: 0 }],
    [mapping[0], { ...mapping[1], backend_device: "CUDA0" }],
    [mapping[0], { ...mapping[1], gpu_index: 2 }],
  ]) {
    assert.throws(
      () => validateExpectedGpuMapping(invalid),
      /INVALID_EXPECTED_GPU_MAPPING/,
    );
  }
  assert.throws(
    () =>
      validateGpuSampleIdentity(mapping, {
        gpu_index: 0,
        gpu_uuid: "GPU-B",
      }),
    /GPU_IDENTITY_MAPPING_DRIFT/,
  );
  assert.throws(
    () =>
      validateGpuSampleIdentity(mapping, {
        gpu_index: 2,
        gpu_uuid: "GPU-C",
      }),
    /GPU_IDENTITY_MAPPING_DRIFT/,
  );
  assert.equal(
    validateObservedGpuSet(mapping, new Set(["GPU-A", "GPU-B"])),
    true,
  );
  assert.throws(
    () => validateObservedGpuSet(mapping, new Set(["GPU-A"])),
    /GPU_IDENTITY_SET_MISMATCH/,
  );
  assert.throws(
    () => validateObservedGpuSet(mapping, new Set(["GPU-A", "GPU-C"])),
    /GPU_IDENTITY_SET_MISMATCH/,
  );
});

test("telemetry session rejects zero/one sample and early clean monitor exit", () => {
  const base = {
    captureStartedNs: 0n,
    stopRequestedNs: 2_000_000_000n,
    monitorExitedEarly: false,
  };
  assert.throws(
    () => validateTelemetrySession({ ...base, clocks: [] }),
    /INSUFFICIENT_TELEMETRY_COVERAGE/,
  );
  assert.throws(
    () => validateTelemetrySession({ ...base, clocks: [1_000_000_000n] }),
    /INSUFFICIENT_TELEMETRY_COVERAGE/,
  );
  assert.throws(
    () =>
      validateTelemetrySession({
        ...base,
        clocks: [500_000_000n, 1_500_000_000n],
        monitorExitedEarly: true,
      }),
    /TELEMETRY_BOUNDARY_COVERAGE_INVALID/,
  );
});

test("query, dmon, and host streams each require independent full-window coverage", () => {
  const valid = [250_000_000n, 1_250_000_000n];
  const base = {
    query: valid,
    dmon: valid,
    host: valid,
    captureStartedNs: 0n,
    stopRequestedNs: 1_500_000_000n,
    exitedBeforeStop: { query: false, dmon: false, host: false },
  };
  assert.deepEqual(Object.keys(validateTelemetryStreams(base)), [
    "query",
    "dmon",
    "host",
  ]);
  for (const name of ["query", "dmon", "host"]) {
    assert.throws(
      () => validateTelemetryStreams({ ...base, [name]: [] }),
      new RegExp(`TELEMETRY_STREAM_INVALID: ${name}:INSUFFICIENT`),
    );
    assert.throws(
      () =>
        validateTelemetryStreams({
          ...base,
          exitedBeforeStop: { ...base.exitedBeforeStop, [name]: true },
        }),
      new RegExp(`TELEMETRY_STREAM_INVALID: ${name}:TELEMETRY_BOUNDARY`),
    );
  }
});

test("each expected GPU independently covers the complete query window", () => {
  const mapping = [
    { backend_device: "CUDA0", gpu_index: 0, gpu_uuid: "GPU-A" },
    { backend_device: "CUDA1", gpu_index: 1, gpu_uuid: "GPU-B" },
  ];
  const base = {
    mapping,
    clocksByUuid: new Map([
      ["GPU-A", [250_000_000n, 1_250_000_000n]],
      ["GPU-B", [300_000_000n, 1_300_000_000n]],
    ]),
    captureStartedNs: 0n,
    stopRequestedNs: 1_500_000_000n,
    monitorExitedEarly: false,
  };
  assert.deepEqual(Object.keys(validatePerGpuCoverage(base)), [
    "GPU-A",
    "GPU-B",
  ]);
  assert.throws(
    () =>
      validatePerGpuCoverage({
        ...base,
        clocksByUuid: new Map([
          ["GPU-A", [250_000_000n, 1_250_000_000n]],
          ["GPU-B", [300_000_000n]],
        ]),
      }),
    /GPU_TELEMETRY_COVERAGE_INVALID: GPU-B:INSUFFICIENT/,
  );
});

test("telemetry gaps longer than five seconds invalidate coverage", () => {
  assert.deepEqual(validateTelemetryCoverage([0n, 1_000_000_000n, 5_000_000_000n]), {
    valid: true,
    maximum_gap_ms: 4000,
  });
  assert.throws(
    () => validateTelemetryCoverage([0n, 6_000_000_000n]),
    /TELEMETRY_GAP_EXCEEDED/,
  );
});

test("telemetry summaries use active-only PCIe minima and never invent dmon values", () => {
  const summary = summarizeTelemetryRows([
    {
      gpu_uuid: "GPU-1",
      request_in_flight: false,
      temperature_c: 40,
      power_w: 20,
      sm_clock_mhz: 100,
      mem_clock_mhz: 200,
      gpu_util_pct: 0,
      mem_util_pct: 0,
      vram_used_mib: 1000,
      pcie_gen_current: 1,
      pcie_width_current: 1,
    },
    {
      gpu_uuid: "GPU-1",
      request_in_flight: true,
      temperature_c: 60,
      power_w: 100,
      sm_clock_mhz: 2000,
      mem_clock_mhz: 7000,
      gpu_util_pct: 90,
      mem_util_pct: 50,
      vram_used_mib: 15000,
      pcie_gen_current: 4,
      pcie_width_current: 16,
    },
  ]);
  assert.equal(summary.by_gpu["GPU-1"].pcie_gen_min_active, 4);
  assert.equal(summary.by_gpu["GPU-1"].pcie_width_min_active, 16);
  assert.equal(summary.by_gpu["GPU-1"].pcie_rx_mb_s_p95, null);
});
