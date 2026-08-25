function finiteArray(value, name, expectedRepetitions) {
  if (!Array.isArray(value) || value.length !== expectedRepetitions) {
    throw new Error(`BENCH_REPETITION_MISMATCH: ${name}`);
  }
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`NONFINITE_BENCH_SAMPLE: ${name}`);
  }
  return [...value];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeSamples(samples) {
  const center = median(samples);
  return {
    repetitions: samples.length,
    median_ts: center,
    minimum_ts: Math.min(...samples),
    maximum_ts: Math.max(...samples),
    median_absolute_deviation_ts: median(
      samples.map((value) => Math.abs(value - center)),
    ),
    arithmetic_mean_ts:
      samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

export function parseBenchJson(stdout, { expectedRepetitions }) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error("INVALID_BENCH_JSON");
  }
  if (!Array.isArray(body) || body.length !== 1 || typeof body[0] !== "object") {
    throw new Error("INVALID_BENCH_JSON_SHAPE");
  }
  const samplesTs = finiteArray(body[0].samples_ts, "samples_ts", expectedRepetitions);
  const samplesNs = finiteArray(body[0].samples_ns, "samples_ns", expectedRepetitions);
  return {
    raw: body,
    samples_ts: samplesTs,
    samples_ns: samplesNs,
    summary: summarizeSamples(samplesTs),
  };
}
