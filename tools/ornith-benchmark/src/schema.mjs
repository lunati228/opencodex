const PHASES = new Set(["cold", "warm", "sustained"]);
const OUTCOMES = new Set(["pass", "fail", "abort"]);
const RESULT_STATUSES = new Set(["complete", "invalid", "aborted"]);
const RESULT_DECISIONS = new Set([
  "REMOVE",
  "FAIL",
  "CONDITIONAL_INTEGRATE",
  "INTEGRATE",
  "STRONG_INTEGRATE",
  "INVALID",
]);
const RESULT_SPEED_BANDS = new Set([
  "lt_2_5",
  "gte_2_5_lt_3_0",
  "gte_3_0_lt_3_5",
  "gte_3_5_lte_4_0",
  "gt_4_0",
]);
const FINAL_BENCH_WORKLOADS = Object.freeze([
  "pp8k",
  "tg1024-d8k",
  "pp16k",
  "tg1024-d16k",
]);

function nullableNumber(value, name) {
  if (value === null || (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  throw new Error(`INVALID_NUMBER: ${name}`);
}

function requiredInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`INVALID_INTEGER: ${name}`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, name, { positive = false } = {}) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive && value <= 0)
  ) {
    throw new Error(`INVALID_NUMBER: ${name}`);
  }
  return value;
}

function validateContextBudget(value) {
  if (!isRecord(value)) throw new Error("INVALID_CONTEXT_BUDGET");
  for (const name of [
    "prompt_tokens",
    "reserved_tokens",
    "context_size",
    "headroom_tokens",
  ]) {
    requiredInteger(value[name], `context_budget.${name}`);
  }
  if (
    value.fits !== true ||
    value.reserved_tokens < 1 ||
    value.context_size < 1 ||
    value.prompt_tokens +
      value.reserved_tokens +
      value.headroom_tokens !==
      value.context_size ||
    typeof value.provenance !== "string" ||
    value.provenance.length < 1 ||
    !/^[a-f0-9]{64}$/.test(value.rendered_prompt_sha256 ?? "") ||
    typeof value.template_provenance !== "string" ||
    value.template_provenance.length < 1
  ) {
    throw new Error("INVALID_CONTEXT_BUDGET");
  }
  return structuredClone(value);
}

export function validateRound(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_ROUND");
  }
  input = {
    ...input,
    reasoning_tokens: input.reasoning_tokens ?? null,
    answer_tokens: input.answer_tokens ?? null,
    cache_n: input.cache_n ?? null,
    tool_calls: input.tool_calls ?? [],
    normal_speed_sample:
      input.normal_speed_sample ??
      (Number.isInteger(input.predicted_n) && input.predicted_n >= 64),
    abort_reason: input.abort_reason ?? null,
    context_budget: input.context_budget ?? null,
  };
  if (!PHASES.has(input.phase)) throw new Error("INVALID_PHASE");
  if (!OUTCOMES.has(input.outcome)) throw new Error("INVALID_OUTCOME");
  if (
    typeof input.case_id !== "string" ||
    !/^[A-Z]-[0-9]{2}$/.test(input.case_id)
  ) {
    throw new Error("INVALID_CASE_ID");
  }
  if (
    typeof input.started_at_utc !== "string" ||
    !Number.isFinite(Date.parse(input.started_at_utc))
  ) {
    throw new Error("INVALID_ROUND_TIMESTAMP");
  }
  requiredInteger(input.round_index, "round_index");
  const timestamps = [
    "request_start_ns",
    "request_sent_ns",
    "first_sse_event_ns",
    "first_output_ns",
    "response_end_ns",
  ];
  for (const name of timestamps) {
    if (input[name] !== null) requiredInteger(input[name], name);
  }
  for (const name of ["cache_n", "prompt_n", "predicted_n"]) {
    if (input[name] !== null) requiredInteger(input[name], name);
  }
  for (const name of ["prompt_ms", "predicted_ms"]) {
    nullableNumber(input[name], name);
  }
  for (const name of ["reasoning_tokens", "answer_tokens"]) {
    if (input[name] !== null) requiredInteger(input[name], name);
  }
  if (!Array.isArray(input.tool_calls)) {
    throw new Error("INVALID_ROUND_TOOL_CALLS");
  }
  for (const name of ["tool_latency_ms_sum", "tool_round_wall_ms"]) {
    if (
      input[name] !== undefined &&
      input[name] !== null &&
      (!Number.isFinite(input[name]) || input[name] < 0)
    ) {
      throw new Error(`INVALID_NUMBER: ${name}`);
    }
  }
  if (typeof input.normal_speed_sample !== "boolean") {
    throw new Error("INVALID_NORMAL_SPEED_SAMPLE");
  }
  if (
    input.abort_reason !== null &&
    typeof input.abort_reason !== "string"
  ) {
    throw new Error("INVALID_ABORT_REASON");
  }
  if (input.context_budget !== null) {
    input.context_budget = validateContextBudget(input.context_budget);
  }
  const prefill =
    input.prompt_n !== null && input.prompt_ms > 0
      ? input.prompt_n / (input.prompt_ms / 1000)
      : null;
  const decode =
    input.predicted_n !== null && input.predicted_ms > 0
      ? input.predicted_n / (input.predicted_ms / 1000)
      : null;
  return {
    ...input,
    prefill_tok_s: prefill,
    decode_tok_s: decode,
    ttft_ms:
      input.first_output_ns !== null && input.request_start_ns !== null
        ? (input.first_output_ns - input.request_start_ns) / 1e6
        : null,
    post_upload_ttft_ms:
      input.first_output_ns !== null && input.request_sent_ns !== null
        ? (input.first_output_ns - input.request_sent_ns) / 1e6
        : null,
    total_wall_ms:
      input.response_end_ns !== null && input.request_start_ns !== null
        ? (input.response_end_ns - input.request_start_ns) / 1e6
        : null,
  };
}

function validateBenchmarks(llamaBench) {
  if (!isRecord(llamaBench) || !isRecord(llamaBench.final)) {
    throw new Error("INVALID_RESULT_BENCHMARKS");
  }
  for (const id of FINAL_BENCH_WORKLOADS) {
    const workload = llamaBench.final[id];
    const sampleValues = Array.isArray(workload?.samples_ts)
      ? workload.samples_ts
      : [];
    const sortedSamples = [...sampleValues]
      .sort((left, right) => left - right);
    const middle = Math.floor(sortedSamples.length / 2);
    const sampleMedian =
      sortedSamples.length % 2 === 1
        ? sortedSamples[middle]
        : (sortedSamples[middle - 1] + sortedSamples[middle]) / 2;
    const sampleMean =
      sampleValues.reduce((sum, value) => sum + value, 0) /
      sampleValues.length;
    const deviations = sortedSamples
      .map((value) => Math.abs(value - sampleMedian))
      .sort((left, right) => left - right);
    const deviationMiddle = Math.floor(deviations.length / 2);
    const sampleMad =
      deviations.length % 2 === 1
        ? deviations[deviationMiddle]
        : (deviations[deviationMiddle - 1] + deviations[deviationMiddle]) / 2;
    if (
      !isRecord(workload) ||
      !Array.isArray(workload.samples_ts) ||
      workload.samples_ts.length < 1 ||
      !Array.isArray(workload.samples_ns) ||
      workload.samples_ns.length !== workload.samples_ts.length ||
      workload.samples_ts.some(
        (value) => !Number.isFinite(value) || value <= 0,
      ) ||
      workload.samples_ns.some(
        (value) => !Number.isFinite(value) || value < 0,
      ) ||
      !Number.isSafeInteger(workload.repetitions) ||
      workload.repetitions !== workload.samples_ts.length ||
      !Number.isFinite(workload.median_ts) ||
      workload.median_ts <= 0 ||
      !Number.isFinite(workload.minimum_ts) ||
      workload.minimum_ts <= 0 ||
      !Number.isFinite(workload.maximum_ts) ||
      workload.maximum_ts <= 0 ||
      !Number.isFinite(workload.median_absolute_deviation_ts) ||
      workload.median_absolute_deviation_ts < 0 ||
      !Number.isFinite(workload.arithmetic_mean_ts) ||
      workload.arithmetic_mean_ts <= 0 ||
      workload.median_ts !== sampleMedian ||
      workload.minimum_ts !== Math.min(...sortedSamples) ||
      workload.maximum_ts !== Math.max(...sortedSamples) ||
      workload.median_absolute_deviation_ts !== sampleMad ||
      workload.arithmetic_mean_ts !== sampleMean
    ) {
      throw new Error(`INVALID_RESULT_BENCHMARKS: ${id}`);
    }
  }
}

const RESULT_ROUND_FIELDS = Object.freeze([
  "phase",
  "case_id",
  "round_index",
  "started_at_utc",
  "request_start_ns",
  "request_sent_ns",
  "first_sse_event_ns",
  "first_output_ns",
  "response_end_ns",
  "cache_n",
  "prompt_n",
  "prompt_ms",
  "prefill_tok_s",
  "predicted_n",
  "predicted_ms",
  "decode_tok_s",
  "ttft_ms",
  "post_upload_ttft_ms",
  "total_wall_ms",
  "reasoning_tokens",
  "answer_tokens",
  "tool_calls",
  "tool_latency_ms_sum",
  "tool_round_wall_ms",
  "normal_speed_sample",
  "outcome",
  "abort_reason",
  "context_budget",
]);

function validateResultRound(round, phase, caseId) {
  try {
    if (
      !isRecord(round) ||
      RESULT_ROUND_FIELDS.some((name) => !Object.hasOwn(round, name)) ||
      round.phase !== phase ||
      round.case_id !== caseId ||
      round.context_budget === null ||
      !Number.isSafeInteger(round.reasoning_tokens) ||
      round.reasoning_tokens < 0 ||
      !Number.isSafeInteger(round.answer_tokens) ||
      round.answer_tokens < 0
    ) {
      throw new Error("ROUND_SHAPE_INVALID");
    }
    const validated = validateRound(round);
    for (const name of [
      "prefill_tok_s",
      "decode_tok_s",
      "ttft_ms",
      "post_upload_ttft_ms",
      "total_wall_ms",
    ]) {
      if (!Object.is(validated[name], round[name])) {
        throw new Error(`ROUND_DERIVED_MEASUREMENT_INVALID: ${name}`);
      }
    }
  } catch {
    throw new Error("INVALID_RESULT_SERVER_ROUND");
  }
}

function validateColdCase(item) {
  if (
    !isRecord(item) ||
    item.case_id !== "C-01" ||
    !Number.isFinite(item.load_duration_ms) ||
    item.load_duration_ms < 0 ||
    !isRecord(item.round) ||
    !isRecord(item.round.timings) ||
    !isRecord(item.round.usage)
  ) {
    throw new Error("INVALID_RESULT_COLD_CASE");
  }
  for (const name of [
    "request_start_ns",
    "request_sent_ns",
    "first_sse_event_ns",
    "first_output_ns",
    "response_end_ns",
  ]) {
    requiredInteger(item.round[name], `cold.${name}`);
  }
  if (
    !Number.isSafeInteger(item.round.timings.predicted_n) ||
    item.round.timings.predicted_n < 1 ||
    !Number.isFinite(item.round.timings.predicted_ms) ||
    item.round.timings.predicted_ms <= 0
  ) {
    throw new Error("INVALID_RESULT_COLD_CASE");
  }
  for (const name of ["ttft_ms", "post_upload_ttft_ms", "total_wall_ms"]) {
    finiteNumber(item.round[name], `cold.${name}`);
  }
}

function validateCaseSet(cases, phase, expectedLength) {
  if (
    !Array.isArray(cases) ||
    cases.length < 1 ||
    (expectedLength !== undefined && cases.length !== expectedLength)
  ) {
    throw new Error("INVALID_RESULT_SERVER_CASES");
  }
  for (const item of cases) {
    if (
      !isRecord(item) ||
      typeof item.case_id !== "string" ||
      !/^[A-Z]-[0-9]{2}$/.test(item.case_id) ||
      !isRecord(item.run) ||
      !Array.isArray(item.run.rounds) ||
      item.run.rounds.length < 1 ||
      !Number.isSafeInteger(item.run.tool_round_count) ||
      item.run.tool_round_count < 0 ||
      !isRecord(item.run.token_counts)
    ) {
      throw new Error("INVALID_RESULT_SERVER_CASES");
    }
    for (const round of item.run.rounds) {
      validateResultRound(round, phase, item.case_id);
    }
    for (const name of ["reasoning", "answer", "tool_calls"]) {
      const field = item.run.token_counts[name];
      if (
        !isRecord(field) ||
        !Number.isSafeInteger(field.count) ||
        field.count < 0 ||
        !/^[a-f0-9]{64}$/.test(field.sha256 ?? "") ||
        !(
          field.provenance === null ||
          typeof field.provenance === "string" &&
            field.provenance.length > 0
        )
      ) {
        throw new Error("INVALID_RESULT_SERVER_TOKEN_COUNTS");
      }
    }
    if (
      !(
        item.run.token_counts.provenance === null ||
        typeof item.run.token_counts.provenance === "string" &&
          item.run.token_counts.provenance.length > 0
      ) ||
      item.run.token_counts.reasoning.count !==
        item.run.rounds.reduce(
          (sum, round) => sum + round.reasoning_tokens,
          0,
        ) ||
      item.run.token_counts.answer.count !==
        item.run.rounds.reduce(
          (sum, round) => sum + round.answer_tokens,
          0,
        )
    ) {
      throw new Error("INVALID_RESULT_SERVER_TOKEN_COUNTS");
    }
  }
}

function validateServerEvidence(server) {
  if (
    !isRecord(server) ||
    !Array.isArray(server.cold) ||
    server.cold.length !== 3 ||
    !isRecord(server.warm) ||
    !isRecord(server.sustained)
  ) {
    throw new Error("INVALID_RESULT_SERVER");
  }
  for (const item of server.cold) validateColdCase(item);
  validateCaseSet(server.warm.cases, "warm", 17);
  validateCaseSet(server.sustained.cases, "sustained");
  if (
    !Array.isArray(server.sustained_scoring_samples) ||
    server.sustained_scoring_samples.length < 10
  ) {
    throw new Error("INVALID_RESULT_SUSTAINED_SAMPLE");
  }
  const sampleIds = new Set();
  for (const sample of server.sustained_scoring_samples) {
    const item = server.sustained.cases[sample?.case_index];
    const round = item?.run?.rounds.find(
      ({ round_index: roundIndex }) => roundIndex === sample?.round_index,
    );
    if (
      !isRecord(sample) ||
      typeof sample.sample_id !== "string" ||
      sample.sample_id.length < 1 ||
      sampleIds.has(sample.sample_id) ||
      !Number.isSafeInteger(sample.case_index) ||
      sample.case_index < 0 ||
      typeof sample.case_id !== "string" ||
      !Number.isSafeInteger(sample.round_index) ||
      sample.round_index < 0 ||
      !Number.isSafeInteger(sample.predicted_n) ||
      sample.predicted_n < 64 ||
      !Number.isFinite(sample.predicted_ms) ||
      sample.predicted_ms <= 0 ||
      !Number.isFinite(sample.decode_tok_s) ||
      sample.decode_tok_s <= 0 ||
      item?.case_id !== sample.case_id ||
      !round ||
      round.predicted_n !== sample.predicted_n ||
      round.predicted_ms !== sample.predicted_ms ||
      round.decode_tok_s !== sample.decode_tok_s
    ) {
      throw new Error("INVALID_RESULT_SUSTAINED_SAMPLE");
    }
    sampleIds.add(sample.sample_id);
  }
}

function validateTelemetrySummary(summary) {
  if (
    !isRecord(summary) ||
    !isRecord(summary.final) ||
    !Array.isArray(summary.cold) ||
    summary.cold.length !== 3 ||
    summary.cold.some((item) => !isRecord(item)) ||
    !isRecord(summary.warm) ||
    !isRecord(summary.sustained)
  ) {
    throw new Error("INVALID_RESULT_TELEMETRY");
  }
}

function validateGate(gate) {
  if (
    !isRecord(gate) ||
    !RESULT_DECISIONS.has(gate.decision) ||
    !Array.isArray(gate.reasons) ||
    gate.reasons.some((reason) => typeof reason !== "string")
  ) {
    throw new Error("INVALID_RESULT_GATE");
  }
  if (gate.decision === "INVALID") {
    if (
      gate.speed_band !== null ||
      gate.minimum_median_decode_ts !== null ||
      gate.minimum_normal_sample_ts !== null ||
      gate.sustained_median_decode_ts !== null
    ) {
      throw new Error("INVALID_RESULT_GATE");
    }
    return;
  }
  if (!RESULT_SPEED_BANDS.has(gate.speed_band)) {
    throw new Error("INVALID_RESULT_GATE");
  }
  for (const name of [
    "minimum_median_decode_ts",
    "minimum_normal_sample_ts",
    "sustained_median_decode_ts",
  ]) {
    try {
      finiteNumber(gate[name], `gate.${name}`, { positive: true });
    } catch {
      throw new Error("INVALID_RESULT_GATE");
    }
  }
}

export function validateResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_RESULT");
  }
  if (
    input.schema_version !== "ornith-bench-1" ||
    typeof input.campaign_id !== "string" ||
    input.campaign_id.length === 0 ||
    typeof input.candidate_id !== "string" ||
    input.candidate_id.length === 0 ||
    !RESULT_STATUSES.has(input.status)
  ) {
    throw new Error("INVALID_RESULT_IDENTITY");
  }
  const identity = input.identity;
  if (
    !identity ||
    typeof identity !== "object" ||
    typeof identity.llama_tag !== "string" ||
    typeof identity.llama_commit !== "string" ||
    !Number.isSafeInteger(identity.build_number) ||
    identity.build_number < 1 ||
    typeof identity.host_id !== "string" ||
    identity.host_id.length === 0 ||
    ["bench_sha256", "server_sha256", "model_sha256", "suite_sha256"].some(
      (name) => !/^[a-f0-9]{64}$/.test(identity[name] ?? ""),
    )
  ) {
    throw new Error("INVALID_RESULT_RUNTIME_IDENTITY");
  }
  const candidate = input.config;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !["mmap", "dio", "none"].includes(candidate.load_mode) ||
    candidate.use_mmap !== (candidate.load_mode === "mmap") ||
    candidate.use_direct_io !== (candidate.load_mode === "dio") ||
    candidate.fit !== "off" ||
    candidate.spec_type !== "none" ||
    candidate.ctx_size !== 8192 ||
    candidate.generation_cap !== 1024 ||
    candidate.reasoning_budget !== 1024
  ) {
    throw new Error("INVALID_RESULT_CONFIG");
  }
  validateBenchmarks(input.llama_bench);
  validateServerEvidence(input.server);
  validateTelemetrySummary(input.telemetry_summary);
  validateGate(input.gate);
  if (
    !input.quality ||
    !Number.isSafeInteger(input.quality.passed) ||
    input.quality.passed < 0 ||
    input.quality.passed > 17 ||
    input.quality.total !== 17 ||
    !input.quality.categories ||
    typeof input.quality.categories !== "object" ||
    Array.isArray(input.quality.categories) ||
    Object.keys(input.quality.categories).length < 1 ||
    Object.values(input.quality.categories).some(
      (category) =>
        !isRecord(category) ||
        !Number.isSafeInteger(category.passed) ||
        category.passed < 0 ||
        !Number.isSafeInteger(category.total) ||
        category.total < 1 ||
        category.passed > category.total,
    ) ||
    Object.values(input.quality.categories).reduce(
      (sum, category) => sum + category.passed,
      0,
    ) !== input.quality.passed ||
    Object.values(input.quality.categories).reduce(
      (sum, category) => sum + category.total,
      0,
    ) !== input.quality.total ||
    typeof input.quality.baseline_pass !== "boolean" ||
    typeof input.quality.exceptional !== "boolean" ||
    !input.raw_sha256 ||
    typeof input.raw_sha256 !== "object" ||
    Array.isArray(input.raw_sha256) ||
    Object.keys(input.raw_sha256).length < 1 ||
    Object.values(input.raw_sha256).some(
      (digest) => !/^[a-f0-9]{64}$/.test(digest),
    )
  ) {
    throw new Error("INVALID_RESULT_EVIDENCE");
  }
  return structuredClone(input);
}

const NONZERO_WHEN_PRESENT = new Set([
  "temperature_c",
  "power_w",
  "sm_clock_mhz",
  "mem_clock_mhz",
  "vram_total_mib",
  "pcie_gen_current",
  "pcie_width_current",
]);

export function validateTelemetryRow(input) {
  requiredInteger(input.monotonic_ns, "monotonic_ns");
  if (typeof input.request_in_flight !== "boolean") {
    throw new Error("INVALID_REQUEST_IN_FLIGHT");
  }
  for (const [name, value] of Object.entries(input)) {
    if (NONZERO_WHEN_PRESENT.has(name) && value === 0) {
      throw new Error(`UNKNOWN_MUST_BE_NULL: ${name}`);
    }
    if (
      name.endsWith("_c") ||
      name.endsWith("_w") ||
      name.endsWith("_mhz") ||
      name.endsWith("_mib") ||
      name.endsWith("_pct") ||
      name.endsWith("_current") ||
      name.endsWith("_mb_s")
    ) {
      nullableNumber(value, name);
    }
  }
  return structuredClone(input);
}
