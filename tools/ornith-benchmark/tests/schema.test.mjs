import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeDerivedJson } from "../src/artifacts.mjs";
import { tempRoot } from "./temp-root.mjs";
import {
  validateResult,
  validateRound,
  validateTelemetryRow,
} from "../src/schema.mjs";

function contextBudget() {
  return {
    fits: true,
    prompt_tokens: 128,
    reserved_tokens: 1024,
    context_size: 8192,
    headroom_tokens: 7040,
    provenance: "llama-server-b10099-/tokenize",
    rendered_prompt_sha256: "e".repeat(64),
    template_provenance: "llama-server-b10099-/apply-template",
  };
}

function protocolRound(phase, caseId) {
  return {
    phase,
    case_id: caseId,
    round_index: 0,
    started_at_utc: "2026-07-24T00:00:00.000Z",
    request_start_ns: 1,
    request_sent_ns: 2,
    first_sse_event_ns: 3,
    first_output_ns: 4,
    response_end_ns: 5,
    cache_n: 0,
    prompt_n: 128,
    prompt_ms: 1_000,
    prefill_tok_s: 128,
    predicted_n: 64,
    predicted_ms: 16_000,
    decode_tok_s: 4,
    ttft_ms: 0.000003,
    post_upload_ttft_ms: 0.000002,
    total_wall_ms: 0.000004,
    reasoning_tokens: 11,
    answer_tokens: 7,
    tool_calls: [],
    tool_latency_ms_sum: 0,
    tool_round_wall_ms: 0,
    normal_speed_sample: true,
    outcome: "pass",
    abort_reason: null,
    context_budget: contextBudget(),
  };
}

function benchWorkload() {
  return {
    samples_ts: [4, 4, 4],
    samples_ns: [1, 1, 1],
    repetitions: 3,
    median_ts: 4,
    minimum_ts: 4,
    maximum_ts: 4,
    median_absolute_deviation_ts: 0,
    arithmetic_mean_ts: 4,
  };
}

function tokenCounts() {
  return {
    reasoning: {
      count: 11,
      provenance: "test-tokenizer",
      sha256: "a".repeat(64),
    },
    answer: {
      count: 7,
      provenance: "test-tokenizer",
      sha256: "b".repeat(64),
    },
    tool_calls: {
      count: 0,
      provenance: null,
      sha256: "c".repeat(64),
    },
    provenance: "test-tokenizer",
  };
}

function validResult() {
  const categories = [
    ...Array(6).fill("edit"),
    ...Array(2).fill("debug"),
    ...Array(3).fill("tool_chain"),
    ...Array(2).fill("ambiguous"),
    ...Array(2).fill("stop_ask"),
    ...Array(2).fill("second_attempt"),
  ];
  const warmCases = categories.map((category, index) => {
    const caseId = `E-${String(index + 1).padStart(2, "0")}`;
    return {
      case_id: caseId,
      category,
      score: { passed: true },
      run: {
        tool_round_count: 0,
        rounds: [protocolRound("warm", caseId)],
        token_counts: tokenCounts(),
      },
    };
  });
  const sustainedCases = Array.from({ length: 10 }, (_, index) => {
    const caseId =
      index < 3
        ? `E-${String(index + 1).padStart(2, "0")}`
        : `T-${String(index + 1).padStart(2, "0")}`;
    return {
      case_id: caseId,
      category: index < 3 ? "edit" : "tool_chain",
      run: {
        tool_round_count: index === 3 ? 3 : 1,
        rounds: [protocolRound("sustained", caseId)],
        token_counts: tokenCounts(),
      },
    };
  });
  return {
    schema_version: "ornith-bench-1",
    campaign_id: "campaign",
    candidate_id: "candidate",
    status: "complete",
    identity: {
      llama_tag: "b10099",
      llama_commit: "a".repeat(40),
      build_number: 10099,
      bench_sha256: "a".repeat(64),
      server_sha256: "b".repeat(64),
      model_sha256: "c".repeat(64),
      suite_sha256: "d".repeat(64),
      host_id: "host",
    },
    config: {
      load_mode: "mmap",
      use_mmap: true,
      use_direct_io: false,
      n_cpu_moe: 60,
      fit: "off",
      spec_type: "none",
      ctx_size: 8192,
      generation_cap: 1024,
      reasoning_budget: 1024,
    },
    llama_bench: {
      final: {
        pp8k: benchWorkload(),
        "tg1024-d8k": benchWorkload(),
        pp16k: benchWorkload(),
        "tg1024-d16k": benchWorkload(),
      },
    },
    server: {
      cold: Array.from({ length: 3 }, () => ({
        case_id: "C-01",
        load_duration_ms: 1_000,
        round: {
          request_start_ns: 1,
          request_sent_ns: 2,
          first_sse_event_ns: 3,
          first_output_ns: 4,
          response_end_ns: 5,
          ttft_ms: 0.000003,
          post_upload_ttft_ms: 0.000002,
          total_wall_ms: 0.000004,
          timings: {
            cache_n: 0,
            prompt_n: 128,
            prompt_ms: 1_000,
            predicted_n: 64,
            predicted_ms: 16_000,
          },
          usage: {},
        },
      })),
      warm: { cases: warmCases },
      sustained: { cases: sustainedCases },
      sustained_scoring_samples: sustainedCases.map(({ case_id: caseId }, index) => ({
        sample_id: `${caseId}:${index}:0`,
        case_index: index,
        case_id: caseId,
        round_index: 0,
        predicted_n: 64,
        predicted_ms: 16_000,
        decode_tok_s: 4,
      })),
    },
    quality: {
      passed: 17,
      total: 17,
      categories: {
        edit: { passed: 6, total: 6 },
        debug: { passed: 2, total: 2 },
        tool_chain: { passed: 3, total: 3 },
        ambiguous: { passed: 2, total: 2 },
        stop_ask: { passed: 2, total: 2 },
        second_attempt: { passed: 2, total: 2 },
      },
      baseline_pass: true,
      exceptional: true,
    },
    telemetry_summary: {
      final: {},
      cold: [{}, {}, {}],
      warm: {},
      sustained: {},
    },
    gate: {
      decision: "INTEGRATE",
      speed_band: "gte_3_5_lte_4_0",
      minimum_median_decode_ts: 4,
      minimum_normal_sample_ts: 4,
      sustained_median_decode_ts: 4,
      reasons: [],
    },
    raw_sha256: { "final/summary.json": "f".repeat(64) },
  };
}

test("round schema preserves unknown measurements as null, not zero", () => {
  const round = validateRound({
    phase: "warm",
    case_id: "E-01",
    round_index: 1,
    started_at_utc: "2026-07-24T00:00:00.000Z",
    request_start_ns: 1,
    request_sent_ns: 2,
    first_sse_event_ns: null,
    first_output_ns: null,
    response_end_ns: null,
    prompt_n: null,
    prompt_ms: null,
    predicted_n: null,
    predicted_ms: null,
    context_budget: null,
    outcome: "abort",
    abort_reason: "dry-run",
  });
  assert.equal(round.prompt_n, null);
  assert.equal(round.decode_tok_s, null);
});

test("telemetry schema rejects synthetic zero for unavailable fields", () => {
  assert.throws(
    () =>
      validateTelemetryRow({
        timestamp_utc: "2026-07-24T00:00:00.000Z",
        monotonic_ns: 1,
        gpu_uuid: "GPU-test",
        pci_bus_id: "0000:01:00.0",
        temperature_c: 0,
        request_in_flight: false,
      }),
    /UNKNOWN_MUST_BE_NULL/,
  );
});

test("published JSON schemas parse without dependencies", async () => {
  for (const name of ["result.schema.json", "round.schema.json", "telemetry.schema.json"]) {
    const url = new URL(`../schemas/${name}`, import.meta.url);
    const schema = JSON.parse(await readFile(url, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    if (name === "round.schema.json") {
      assert.ok(schema.required.includes("context_budget"));
      assert.equal(schema.properties.context_budget.type.includes("object"), true);
    }
  }
});

test("authoritative candidate results validate the complete emitted structure", () => {
  const result = validResult();
  assert.deepEqual(validateResult(result), result);

  delete result.llama_bench.final.pp16k;
  assert.throws(() => validateResult(result), /INVALID_RESULT_BENCHMARKS/);

  const invalidRound = validResult();
  invalidRound.server.warm.cases[0].run.rounds[0].context_budget = null;
  assert.throws(
    () => validateResult(invalidRound),
    /INVALID_RESULT_SERVER_ROUND/,
  );

  const invalidConfig = validResult();
  invalidConfig.config.use_mmap = false;
  assert.throws(
    () => validateResult(invalidConfig),
    /INVALID_RESULT_CONFIG/,
  );
});

test("the JSON written to result.json is validated after raw-hash injection", async () => {
  const root = await tempRoot("ornith-result-schema-");
  const rawPath = path.join(root, "summary.json");
  const resultPath = path.join(root, "result.json");
  await writeFile(rawPath, "{}\n");
  await writeDerivedJson(
    resultPath,
    validResult(),
    [rawPath],
    { keyRoot: root },
  );
  const emitted = JSON.parse(await readFile(resultPath, "utf8"));
  assert.deepEqual(validateResult(emitted), emitted);

  emitted.server.sustained_scoring_samples[0].predicted_n = 63;
  assert.throws(
    () => validateResult(emitted),
    /INVALID_RESULT_SUSTAINED_SAMPLE/,
  );
});
