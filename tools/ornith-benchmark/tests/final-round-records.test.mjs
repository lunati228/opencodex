import assert from "node:assert/strict";
import test from "node:test";

import { modelRoundRecords } from "../src/final-live-runner.mjs";

function input() {
  return {
    config: {
      campaign_id: "campaign",
      candidate_id: "candidate",
      candidate: {
        llama_tag: "b10099",
        llama_commit: "a".repeat(40),
        load_mode: "mmap",
        fit: "off",
        backend_devices: ["CUDA0", "CUDA1"],
        device_order: ["GPU-A", "GPU-B"],
        split_mode: "layer",
        experimental: false,
        tensor_split: [0.75, 0.25],
        n_gpu_layers: 99,
        n_cpu_moe: 60,
        ctx_size: 8192,
        generation_cap: 1024,
        batch: 2048,
        ubatch: 512,
        threads: 20,
        threads_batch: 20,
        cpu_mask: "fffff",
        cpu_strict: true,
        priority: 2,
        poll: 50,
        flash_attn: "on",
        cache_type_k: "q8_0",
        cache_type_v: "q8_0",
        kv_offload: true,
        op_offload: true,
        cache_ram_mib: 0,
        spec_type: "none",
        reasoning_format: "deepseek",
        reasoning_budget: 1024,
        sampling: {
          seed: 7,
          temperature: 0.2,
          top_p: 0.95,
          min_p: 0.05,
          top_k: 40,
        },
      },
    },
    preflight: {
      paths: { llama_server: { sha256: "b".repeat(64) } },
      hash_evidence: { model_sha256: "c".repeat(64) },
    },
  };
}

test("CSV round records use protocol phases and retain known identity, config, and token counts", () => {
  const { config, preflight } = input();
  const records = modelRoundRecords(config, preflight, "warm-quality", [{
    case_id: "E-02",
    score: { passed: true, final_tests: { ok: true } },
    run: {
      tool_round_count: 1,
      token_counts: {
        reasoning: { count: 999 },
        answer: { count: 999 },
      },
      rounds: [
        {
          phase: "warm",
          case_id: "E-02",
          round_index: 0,
          started_at_utc: "2026-07-26T00:00:00.000Z",
          request_start_ns: 1,
          request_sent_ns: 2,
          first_sse_event_ns: 3,
          first_output_ns: 4,
          response_end_ns: 5,
          cache_n: 0,
          prompt_n: 128,
          prompt_ms: 1_000,
          predicted_n: 64,
          predicted_ms: 16_000,
          reasoning_tokens: 11,
          answer_tokens: 7,
          tool_calls: [],
          normal_speed_sample: true,
          outcome: "pass",
          abort_reason: null,
        },
      ],
    },
  }]);

  assert.equal(records[0].phase, "warm");
  assert.equal(records[0].reasoning_tokens, 11);
  assert.equal(records[0].answer_tokens, 7);
  assert.equal(records[0].host_id.length > 0, true);
  assert.equal(records[0].use_mmap, true);
  assert.equal(records[0].use_direct_io, false);
  assert.equal(records[0].fit, "off");
  assert.equal(records[0].prompt_target, 7168);
  assert.equal(records[0].gen_target, 1024);
  assert.equal(records[0].request_start_ns, 1);
  assert.equal(records[0].decode_tok_s, 4);

  const aggregateOnly = modelRoundRecords(
    config,
    preflight,
    "warm-quality",
    [{
      case_id: "E-03",
      score: { passed: true },
      run: {
        token_counts: {
          reasoning: { count: 13 },
          answer: { count: 9 },
        },
        rounds: [{
          phase: "warm",
          case_id: "E-03",
          round_index: 0,
          started_at_utc: "2026-07-26T00:00:00.000Z",
          request_start_ns: 1,
          request_sent_ns: 2,
          first_sse_event_ns: 3,
          first_output_ns: 4,
          response_end_ns: 5,
          cache_n: 0,
          prompt_n: 128,
          prompt_ms: 1_000,
          predicted_n: 64,
          predicted_ms: 16_000,
          tool_calls: [],
          normal_speed_sample: true,
          outcome: "pass",
          abort_reason: null,
        }],
      },
    }],
  );
  assert.equal(aggregateOnly[0].reasoning_tokens, null);
  assert.equal(aggregateOnly[0].answer_tokens, null);
  assert.throws(
    () => modelRoundRecords(config, preflight, "cold-unknown", []),
    /UNIT_MODEL_ROUND_PHASE_INVALID/,
  );
});
