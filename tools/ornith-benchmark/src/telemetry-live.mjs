const QUERY_FIELDS = [
  "timestamp",
  "index",
  "uuid",
  "pci.bus_id",
  "temperature.gpu",
  "power.draw",
  "clocks.sm",
  "clocks.mem",
  "memory.used",
  "memory.total",
  "utilization.gpu",
  "utilization.memory",
  "pcie.link.gen.current",
  "pcie.link.width.current",
];

export function createTelemetryWatchdog({
  keys,
  maximumGapMs,
  onStale,
  nowNs = () => process.hrtime.bigint(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.some((key) => typeof key !== "string" || key.length === 0) ||
    new Set(keys).size !== keys.length ||
    !Number.isFinite(maximumGapMs) ||
    maximumGapMs <= 0 ||
    typeof onStale !== "function"
  ) {
    throw new Error("INVALID_TELEMETRY_WATCHDOG");
  }
  const maximumGapNs = BigInt(Math.floor(maximumGapMs * 1e6));
  const deadlines = new Map(
    keys.map((key) => [key, nowNs() + maximumGapNs]),
  );
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeoutFn(timer);
    const earliest = [...deadlines.values()].reduce(
      (left, right) => (left < right ? left : right),
    );
    const remainingNs = earliest - nowNs();
    const delayMs =
      remainingNs <= 0n
        ? 0
        : Math.max(1, Math.ceil(Number(remainingNs) / 1e6));
    timer = setTimeoutFn(checkNow, delayMs);
  };

  function checkNow() {
    if (stopped) return [];
    timer = null;
    const current = nowNs();
    const staleKeys = [...deadlines]
      .filter(([, deadline]) => deadline <= current)
      .map(([key]) => key)
      .sort();
    if (staleKeys.length > 0) {
      stopped = true;
      const error = new Error(
        `TELEMETRY_WATCHDOG_STALE: ${staleKeys.join(",")}`,
      );
      error.code = "TELEMETRY_WATCHDOG_STALE";
      error.stale_keys = staleKeys;
      onStale(error);
      return staleKeys;
    }
    schedule();
    return [];
  }

  const touch = (key) => {
    if (stopped) return;
    if (!deadlines.has(key)) {
      throw new Error(`UNKNOWN_TELEMETRY_WATCHDOG_KEY: ${key}`);
    }
    deadlines.set(key, nowNs() + maximumGapNs);
    schedule();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  };

  schedule();
  return {
    touch,
    checkNow,
    stop,
    keys: () => [...deadlines.keys()],
  };
}

export function buildDmonArgv() {
  return ["dmon", "-s", "pucvmet", "-d", "1", "-o", "DT"];
}

const HOST_MONITOR_COUNTERS = Object.freeze([
  "\\Processor(_Total)\\% Processor Time",
  "\\Memory\\% Committed Bytes In Use",
  "\\PhysicalDisk(_Total)\\Disk Bytes/sec",
  "\\Memory\\Available Bytes",
  "\\Memory\\Pages Input/sec",
  "\\Memory\\Page Reads/sec",
]);

export function buildHostMonitorArgv(sampleCount = 86_400) {
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < 2 ||
    sampleCount > 86_400
  ) {
    throw new Error("INVALID_HOST_MONITOR_SAMPLE_COUNT");
  }
  return [
    ...HOST_MONITOR_COUNTERS,
    "-si",
    "1",
    "-sc",
    String(sampleCount),
  ];
}

export function parseCsvFields(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("INVALID_CSV_QUOTING");
  fields.push(value);
  return fields;
}

function typeperfNumber(value) {
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

export function parseTypeperfSample(header, line, expectedPhysicalBytes) {
  if (
    !Number.isSafeInteger(expectedPhysicalBytes) ||
    expectedPhysicalBytes < 1
  ) {
    throw new Error("INVALID_EXPECTED_PHYSICAL_MEMORY_BYTES");
  }
  let names = parseCsvFields(header);
  const values = parseCsvFields(line);
  const matchesCounter = (name, counter) =>
    name.toLowerCase().endsWith(counter.toLowerCase());
  const omittedProcessorHeader =
    names.length === HOST_MONITOR_COUNTERS.length &&
    values.length === HOST_MONITOR_COUNTERS.length + 1 &&
    names
      .slice(1)
      .every((name, index) =>
        matchesCounter(name, HOST_MONITOR_COUNTERS[index + 1]),
      );
  if (omittedProcessorHeader) {
    names = [names[0], HOST_MONITOR_COUNTERS[0], ...names.slice(1)];
  }
  if (
    names.length !== HOST_MONITOR_COUNTERS.length + 1 ||
    values.length !== HOST_MONITOR_COUNTERS.length + 1 ||
    !HOST_MONITOR_COUNTERS.every((counter, index) =>
      matchesCounter(names[index + 1], counter),
    )
  ) {
    throw new Error("TYPEPERF_COLUMN_MISMATCH");
  }
  const measurements = values.slice(1).map(typeperfNumber);
  if (measurements.some((measurement) => measurement === null)) {
    throw new Error("TYPEPERF_REQUIRED_COUNTER_MISSING");
  }
  const [
    cpuUtilPct,
    committedPct,
    diskBytesPerSecond,
    availableBytes,
    pagesInput,
    pageReads,
  ] = measurements;
  return {
    cpu_util_pct: cpuUtilPct,
    committed_pct: committedPct,
    disk_bytes_per_sec: diskBytesPerSecond,
    available_bytes: availableBytes,
    available_fraction: availableBytes / expectedPhysicalBytes,
    pages_input_per_sec: pagesInput,
    page_reads_per_sec: pageReads,
  };
}

export function validateExpectedGpuMapping(mapping) {
  if (!Array.isArray(mapping) || mapping.length < 1) {
    throw new Error("INVALID_EXPECTED_GPU_MAPPING");
  }
  const indices = new Set();
  const uuids = new Set();
  const backendDevices = new Set();
  for (const entry of mapping) {
    const backendMatch =
      typeof entry?.backend_device === "string"
        ? /^CUDA(\d+)$/.exec(entry.backend_device)
        : null;
    if (
      !backendMatch ||
      !Number.isSafeInteger(entry.gpu_index) ||
      entry.gpu_index < 0 ||
      Number(backendMatch[1]) !== entry.gpu_index ||
      typeof entry.gpu_uuid !== "string" ||
      entry.gpu_uuid.length === 0 ||
      indices.has(entry.gpu_index) ||
      uuids.has(entry.gpu_uuid) ||
      backendDevices.has(entry.backend_device)
    ) {
      throw new Error("INVALID_EXPECTED_GPU_MAPPING");
    }
    indices.add(entry.gpu_index);
    uuids.add(entry.gpu_uuid);
    backendDevices.add(entry.backend_device);
  }
  return mapping.map((entry) => ({ ...entry }));
}

export function validateGpuSampleIdentity(mapping, sample) {
  const validated = validateExpectedGpuMapping(mapping);
  const expected = validated.find(
    ({ gpu_index }) => gpu_index === sample?.gpu_index,
  );
  if (!expected || expected.gpu_uuid !== sample?.gpu_uuid) {
    throw new Error("GPU_IDENTITY_MAPPING_DRIFT");
  }
  return expected;
}

export function validateObservedGpuSet(mapping, observedUuids) {
  const validated = validateExpectedGpuMapping(mapping);
  if (!(observedUuids instanceof Set)) {
    throw new Error("GPU_IDENTITY_SET_MISMATCH");
  }
  const expected = new Set(validated.map(({ gpu_uuid }) => gpu_uuid));
  if (
    observedUuids.size !== expected.size ||
    [...expected].some((uuid) => !observedUuids.has(uuid))
  ) {
    throw new Error("GPU_IDENTITY_SET_MISMATCH");
  }
  return true;
}

export function enforceDmonSafety(sample) {
  const nonzero = (value) => value !== null && value !== undefined && value !== 0;
  if (
    nonzero(sample?.pci) ||
    nonzero(sample?.sbecc) ||
    nonzero(sample?.dbecc)
  ) {
    throw new Error("DMON_PCI_OR_ECC_ERROR");
  }
  return sample;
}

export function updateThermalSafety(
  consecutiveByUuid,
  sample,
  abortTemperatureC,
) {
  if (
    !(consecutiveByUuid instanceof Map) ||
    typeof sample?.gpu_uuid !== "string" ||
    !Number.isFinite(abortTemperatureC)
  ) {
    throw new Error("INVALID_THERMAL_SAFETY_INPUT");
  }
  if (!Number.isFinite(sample.temperature_c)) {
    throw new Error(`GPU_TEMPERATURE_UNAVAILABLE: ${sample.gpu_uuid}`);
  }
  const prior = consecutiveByUuid.get(sample.gpu_uuid) ?? 0;
  const current =
    sample.temperature_c >= abortTemperatureC
      ? prior + 1
      : 0;
  consecutiveByUuid.set(sample.gpu_uuid, current);
  if (current >= 5) {
    throw new Error(`THERMAL_ABORT: ${sample.gpu_uuid}`);
  }
  return current;
}

export const HOST_AVAILABLE_FRACTION_FLOOR = 0.05;

// The host monitor samples at 1 Hz, so this is a 30-second floor. Memory
// mapping a checkpoint far larger than RAM necessarily drives Windows
// `Memory\Available Bytes` low while llama.cpp prefetches the mapped range;
// that transient is expected and recovers. Sustained starvation is not. The
// value of the floor is unchanged - only its duration is qualified.
export const HOST_AVAILABLE_SUSTAINED_SAMPLES = 30;

// Committed memory is a hard abort: unlike available bytes it measures real
// commit against the pagefile, and Windows begins failing allocations
// process-wide as it approaches the limit. Observed at 99.19% on the first
// live attempt, so this threshold is load-bearing, not decorative.
export const HOST_COMMITTED_ABORT_PCT = 95;

// How much host RAM to keep out of the benchmark's reach so the desktop stays
// usable. Expressed as an absolute reserve because that is the quantity an
// operator actually reasons about ("leave Windows 2 GB"), not as a fraction of
// a total they would have to look up. A fraction floor is still accepted for
// callers that prefer it; the effective floor is whichever is stricter.
export function validateHostSafetyLimits(limits = {}) {
  const {
    available_floor_fraction: fraction = HOST_AVAILABLE_FRACTION_FLOOR,
    available_reserve_bytes: reserveBytes = null,
    sustained_samples: sustained = HOST_AVAILABLE_SUSTAINED_SAMPLES,
    committed_abort_pct: committed = HOST_COMMITTED_ABORT_PCT,
  } = limits ?? {};
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new Error("INVALID_HOST_AVAILABLE_FLOOR");
  }
  if (
    reserveBytes !== null &&
    (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1)
  ) {
    throw new Error("INVALID_HOST_AVAILABLE_RESERVE");
  }
  if (
    !Number.isInteger(sustained) ||
    sustained < 1 ||
    sustained > 3600
  ) {
    throw new Error("INVALID_HOST_SUSTAINED_SAMPLES");
  }
  if (!Number.isFinite(committed) || committed <= 0 || committed > 100) {
    throw new Error("INVALID_HOST_COMMITTED_ABORT_PCT");
  }
  return Object.freeze({
    available_floor_fraction: fraction,
    available_reserve_bytes: reserveBytes,
    sustained_samples: sustained,
    committed_abort_pct: committed,
  });
}

// Operator-facing shape. Expressed in GiB and seconds because those are the
// units an operator sets a reservation in; bytes and sample counts are an
// implementation detail. The host monitor samples at 1 Hz (`-si 1`), so
// seconds and samples are one-to-one.
export function hostSafetyLimitsFromConfig(reserve) {
  if (reserve === undefined || reserve === null) {
    return validateHostSafetyLimits();
  }
  if (typeof reserve !== "object" || Array.isArray(reserve)) {
    throw new Error("INVALID_HOST_RESERVE");
  }
  const {
    available_reserve_gib: reserveGib,
    sustained_seconds: sustainedSeconds,
    committed_abort_pct: committedPct,
    available_floor_fraction: floorFraction,
  } = reserve;
  if (
    reserveGib !== undefined &&
    (!Number.isFinite(reserveGib) || reserveGib <= 0 || reserveGib > 1024)
  ) {
    throw new Error("INVALID_HOST_RESERVE_GIB");
  }
  if (
    sustainedSeconds !== undefined &&
    (!Number.isInteger(sustainedSeconds) || sustainedSeconds < 1)
  ) {
    throw new Error("INVALID_HOST_RESERVE_SUSTAINED_SECONDS");
  }
  return validateHostSafetyLimits({
    ...(floorFraction === undefined
      ? {}
      : { available_floor_fraction: floorFraction }),
    ...(reserveGib === undefined
      ? {}
      : {
          available_reserve_bytes: Math.round(reserveGib * 1024 ** 3),
        }),
    ...(sustainedSeconds === undefined
      ? {}
      : { sustained_samples: sustainedSeconds }),
    ...(committedPct === undefined
      ? {}
      : { committed_abort_pct: committedPct }),
  });
}

export function createHostSafetyState(limits) {
  return {
    consecutive_below_floor: 0,
    limits: validateHostSafetyLimits(limits),
  };
}

export function updateHostSafety(state, sample) {
  if (!Number.isInteger(state?.consecutive_below_floor)) {
    throw new Error("INVALID_HOST_SAFETY_STATE");
  }
  const limits = validateHostSafetyLimits(state.limits);
  if (sample?.committed_pct >= limits.committed_abort_pct) {
    throw new Error("HOST_COMMIT_ABORT");
  }
  if (!Number.isFinite(sample?.available_fraction)) {
    throw new Error("HOST_AVAILABLE_MEMORY_UNAVAILABLE");
  }
  const belowFraction =
    sample.available_fraction < limits.available_floor_fraction;
  // An absolute reserve only participates when the sample actually carries
  // absolute bytes; a fraction-only sample must not silently pass a check the
  // operator asked for.
  const belowReserve =
    limits.available_reserve_bytes !== null &&
    (!Number.isFinite(sample?.available_bytes) ||
      sample.available_bytes < limits.available_reserve_bytes);
  state.consecutive_below_floor =
    belowFraction || belowReserve ? state.consecutive_below_floor + 1 : 0;
  if (state.consecutive_below_floor >= limits.sustained_samples) {
    throw new Error("HOST_AVAILABLE_MEMORY_ABORT");
  }
  return state.consecutive_below_floor;
}

export function createDmonIdentityTracker(mapping) {
  const validated = validateExpectedGpuMapping(mapping);
  return {
    mapping: validated,
    clocksByUuid: new Map(
      validated.map(({ gpu_uuid }) => [gpu_uuid, []]),
    ),
    cycleIndices: new Map(),
  };
}

export function recordDmonGpuSample(tracker, sample, monotonicNs) {
  if (
    !tracker ||
    !Array.isArray(tracker.mapping) ||
    !(tracker.clocksByUuid instanceof Map) ||
    !(tracker.cycleIndices instanceof Map) ||
    typeof sample?.source_timestamp !== "string" ||
    sample.source_timestamp.length === 0 ||
    !Number.isSafeInteger(sample.gpu) ||
    typeof monotonicNs !== "bigint"
  ) {
    throw new Error("INVALID_DMON_IDENTITY_SAMPLE");
  }
  const expected = tracker.mapping.find(
    ({ gpu_index }) => gpu_index === sample.gpu,
  );
  if (!expected) throw new Error("DMON_GPU_IDENTITY_MAPPING_DRIFT");
  const indices =
    tracker.cycleIndices.get(sample.source_timestamp) ?? new Set();
  if (indices.has(sample.gpu)) {
    throw new Error("DMON_DUPLICATE_GPU_IN_SAMPLE");
  }
  indices.add(sample.gpu);
  tracker.cycleIndices.set(sample.source_timestamp, indices);
  tracker.clocksByUuid.get(expected.gpu_uuid).push(monotonicNs);
  return {
    ...sample,
    backend_device: expected.backend_device,
    gpu_uuid: expected.gpu_uuid,
  };
}

export function parseDmonDataLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const fields = trimmed.split(/\s+/);
  // -o DT prefixes date and time; the protocol fields follow.
  const prefix = fields.slice(0, -22);
  const values = fields.slice(-22);
  if (
    values.length !== 22 ||
    prefix.length !== 2 ||
    prefix.some((value) => value.length === 0)
  ) {
    throw new Error("INVALID_DMON_ROW");
  }
  const headings = [
    "gpu", "pwr", "gtemp", "mtemp", "sm", "mem", "enc", "dec", "jpg",
    "ofa", "mclk", "pclk", "pviol", "tviol", "fb", "bar1", "ccpm",
    "sbecc", "dbecc", "pci", "rxpci", "txpci",
  ];
  return {
    source_timestamp: `${prefix[0]} ${prefix[1]}`,
    ...Object.fromEntries(
      headings.map((name, index) => [name, nullableNumber(values[index])]),
    ),
  };
}

export function buildNvidiaQueryArgv() {
  return [
    `--query-gpu=${QUERY_FIELDS.join(",")}`,
    "--format=csv,noheader,nounits",
    "-l",
    "1",
  ];
}

function nullableNumber(value) {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "-" ||
    trimmed === "[N/A]" ||
    trimmed.toLowerCase() === "n/a" ||
    trimmed.toLowerCase() === "unsupported"
  ) {
    return null;
  }
  const number = Number(trimmed);
  if (!Number.isFinite(number)) throw new Error(`INVALID_TELEMETRY_VALUE: ${value}`);
  return number;
}

export function parseNvidiaCsvRow(line) {
  const fields = line.split(",").map((value) => value.trim());
  if (fields.length !== QUERY_FIELDS.length) throw new Error("INVALID_NVIDIA_CSV_ROW");
  return {
    timestamp_utc: fields[0],
    gpu_index: nullableNumber(fields[1]),
    gpu_uuid: fields[2],
    pci_bus_id: fields[3],
    temperature_c: nullableNumber(fields[4]),
    power_w: nullableNumber(fields[5]),
    sm_clock_mhz: nullableNumber(fields[6]),
    mem_clock_mhz: nullableNumber(fields[7]),
    vram_used_mib: nullableNumber(fields[8]),
    vram_total_mib: nullableNumber(fields[9]),
    gpu_util_pct: nullableNumber(fields[10]),
    mem_util_pct: nullableNumber(fields[11]),
    pcie_gen_current: nullableNumber(fields[12]),
    pcie_width_current: nullableNumber(fields[13]),
  };
}

export function validateTelemetryCoverage(monotonicNsValues) {
  if (!Array.isArray(monotonicNsValues) || monotonicNsValues.length < 2) {
    throw new Error("INSUFFICIENT_TELEMETRY_COVERAGE");
  }
  let maximumGapNs = 0n;
  for (let index = 1; index < monotonicNsValues.length; index += 1) {
    const gap = monotonicNsValues[index] - monotonicNsValues[index - 1];
    if (gap < 0n) throw new Error("TELEMETRY_CLOCK_MOVED_BACKWARD");
    if (gap > 5_000_000_000n) throw new Error("TELEMETRY_GAP_EXCEEDED");
    if (gap > maximumGapNs) maximumGapNs = gap;
  }
  return { valid: true, maximum_gap_ms: Number(maximumGapNs) / 1e6 };
}

export function validateTelemetrySession({
  clocks,
  captureStartedNs,
  stopRequestedNs,
  monitorExitedEarly,
}) {
  if (!Array.isArray(clocks) || clocks.length < 2) {
    throw new Error("INSUFFICIENT_TELEMETRY_COVERAGE");
  }
  const coverage = validateTelemetryCoverage(clocks);
  if (
    monitorExitedEarly ||
    clocks[0] - captureStartedNs > 5_000_000_000n ||
    stopRequestedNs - clocks.at(-1) > 5_000_000_000n
  ) {
    throw new Error("TELEMETRY_BOUNDARY_COVERAGE_INVALID");
  }
  return coverage;
}

export function validateTelemetryStreams({
  query,
  dmon,
  host,
  captureStartedNs,
  stopRequestedNs,
  exitedBeforeStop,
}) {
  const coverage = {};
  for (const [name, clocks] of Object.entries({ query, dmon, host })) {
    try {
      coverage[name] = validateTelemetrySession({
        clocks,
        captureStartedNs,
        stopRequestedNs,
        monitorExitedEarly: Boolean(exitedBeforeStop?.[name]),
      });
    } catch (error) {
      throw new Error(`TELEMETRY_STREAM_INVALID: ${name}:${error.message}`);
    }
  }
  return coverage;
}

export function validatePerGpuCoverage({
  mapping,
  clocksByUuid,
  captureStartedNs,
  stopRequestedNs,
  monitorExitedEarly,
}) {
  const validated = validateExpectedGpuMapping(mapping);
  if (
    !(clocksByUuid instanceof Map) ||
    clocksByUuid.size !== validated.length
  ) {
    throw new Error("GPU_TELEMETRY_SET_INVALID");
  }
  const coverage = {};
  for (const { gpu_uuid: uuid } of validated) {
    if (!clocksByUuid.has(uuid)) throw new Error("GPU_TELEMETRY_SET_INVALID");
    try {
      coverage[uuid] = validateTelemetrySession({
        clocks: clocksByUuid.get(uuid),
        captureStartedNs,
        stopRequestedNs,
        monitorExitedEarly,
      });
    } catch (error) {
      throw new Error(`GPU_TELEMETRY_COVERAGE_INVALID: ${uuid}:${error.message}`);
    }
  }
  return coverage;
}

function percentile(values, quantile) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index];
}

function average(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

export function summarizeTelemetryRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.gpu_uuid) ?? [];
    group.push(row);
    groups.set(row.gpu_uuid, group);
  }
  const byGpu = {};
  for (const [gpuUuid, samples] of groups) {
    const active = samples.filter((row) => row.request_in_flight);
    byGpu[gpuUuid] = {
      samples: samples.length,
      active_samples: active.length,
      temperature_c_max: percentile(samples.map((row) => row.temperature_c), 1),
      temperature_c_p95: percentile(samples.map((row) => row.temperature_c), 0.95),
      power_w_average: average(samples.map((row) => row.power_w)),
      power_w_p95: percentile(samples.map((row) => row.power_w), 0.95),
      sm_clock_mhz_p50: percentile(active.map((row) => row.sm_clock_mhz), 0.5),
      sm_clock_mhz_min_active: percentile(active.map((row) => row.sm_clock_mhz), 0),
      mem_clock_mhz_p50: percentile(active.map((row) => row.mem_clock_mhz), 0.5),
      mem_clock_mhz_min_active: percentile(active.map((row) => row.mem_clock_mhz), 0),
      gpu_util_pct_p50: percentile(active.map((row) => row.gpu_util_pct), 0.5),
      gpu_util_pct_p95: percentile(active.map((row) => row.gpu_util_pct), 0.95),
      mem_util_pct_p50: percentile(active.map((row) => row.mem_util_pct), 0.5),
      mem_util_pct_p95: percentile(active.map((row) => row.mem_util_pct), 0.95),
      vram_used_mib_max: percentile(samples.map((row) => row.vram_used_mib), 1),
      pcie_gen_min_active: percentile(active.map((row) => row.pcie_gen_current), 0),
      pcie_width_min_active: percentile(active.map((row) => row.pcie_width_current), 0),
      pcie_rx_mb_s_p50: null,
      pcie_rx_mb_s_p95: null,
      pcie_tx_mb_s_p50: null,
      pcie_tx_mb_s_p95: null,
      throttle_or_error: null,
    };
  }
  return { by_gpu: byGpu };
}
