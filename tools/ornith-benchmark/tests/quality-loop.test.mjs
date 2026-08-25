import assert from "node:assert/strict";
import test from "node:test";

import { runToolCase } from "../src/quality-loop.mjs";

function contextBudget(promptTokens) {
  return {
    fits: true,
    prompt_tokens: promptTokens,
    reserved_tokens: 1024,
    context_size: 8192,
    headroom_tokens: 8192 - 1024 - promptTokens,
    provenance: "llama-server-b10099-/tokenize",
    rendered_prompt_sha256: "a".repeat(64),
    template_provenance: "llama-server-b10099-/apply-template",
  };
}

test("tool loop appends assistant calls and results once in original ID order", async () => {
  const requests = [];
  const responses = [
    {
      reasoning_content: "inspect",
      content: null,
      tool_calls: [
        { id: "c2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
        { id: "c1", type: "function", function: { name: "get_diff", arguments: "{}" } },
      ],
      timings: { cache_n: 0, prompt_n: 10, prompt_ms: 5, predicted_n: 3, predicted_ms: 6 },
      usage: { prompt_tokens: 10 },
    },
    {
      reasoning_content: "",
      content: "done",
      tool_calls: [],
      timings: { cache_n: 8, prompt_n: 4, prompt_ms: 2, predicted_n: 2, predicted_ms: 4 },
      usage: { prompt_tokens: 12 },
    },
  ];
  const result = await runToolCase({
    phase: "warm",
    caseId: "E-01",
    initialMessages: [{ role: "user", content: "fix" }],
    tools: [],
    sampling: { seed: 1, temperature: 0, top_p: 1, min_p: 0, top_k: 1 },
    reasoningFormat: "deepseek",
    model: "ornith-local",
    context: {},
    verifyRenderedPrompt: async ({ messages }) => contextBudget(messages.length),
    streamRound: async ({ request }) => {
      requests.push(request);
      return {
        assistant: responses.shift(),
        request_start_ns: 100n,
        request_sent_ns: 110n,
        first_sse_event_ns: 120n,
        first_output_ns: 130n,
        response_end_ns: 160n,
      };
    },
    executeToolFn: async (_context, name, input) => ({
      ok: true,
      error_code: null,
      stdout: JSON.stringify({ name, input }),
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }),
    tokenizeText: async (text) => ({ count: text.length, provenance: "test-tokenizer" }),
    nowNs: () => 1_000n,
  });
  assert.equal(result.rounds.length, 2);
  assert.equal(requests[0].cache_prompt, false);
  assert.equal(requests[1].cache_prompt, true);
  const secondMessages = requests[1].messages;
  assert.equal(secondMessages.filter((message) => message.role === "assistant").length, 1);
  assert.deepEqual(
    secondMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["c2", "c1"],
  );
  assert.equal(result.final_answer, "done");
  assert.equal(result.token_counts.provenance, "test-tokenizer");
  assert.deepEqual(
    result.rounds.map(({ reasoning_tokens, answer_tokens }) => ({
      reasoning_tokens,
      answer_tokens,
    })),
    [
      { reasoning_tokens: 7, answer_tokens: 0 },
      { reasoning_tokens: 0, answer_tokens: 4 },
    ],
  );
  assert.equal(result.token_counts.reasoning.count, 7);
  assert.equal(result.token_counts.answer.count, 4);
  assert.equal(result.rounds[0].context_budget.prompt_tokens, 1);
  assert.deepEqual(
    result.rounds.map(({ normal_speed_sample }) => normal_speed_sample),
    [false, false],
  );
});

test("malformed tool arguments receive one non-mutating retry then invalidate", async () => {
  let attempts = 0;
  await assert.rejects(
    runToolCase({
      phase: "warm",
      caseId: "E-01",
      initialMessages: [{ role: "user", content: "fix" }],
      tools: [],
      sampling: { seed: 1, temperature: 0, top_p: 1, min_p: 0, top_k: 1 },
      reasoningFormat: "deepseek",
      model: "ornith-local",
      context: {},
      verifyRenderedPrompt: async () => contextBudget(1),
      streamRound: async () => {
        attempts += 1;
        return {
          assistant: {
            reasoning_content: "",
            content: null,
            tool_calls: [
              { id: "bad", type: "function", function: { name: "read_file", arguments: "{" } },
            ],
            timings: { cache_n: 0, prompt_n: 1, prompt_ms: 1, predicted_n: 1, predicted_ms: 1 },
            usage: {},
          },
          request_start_ns: 1n,
          request_sent_ns: 2n,
          first_sse_event_ns: 3n,
          first_output_ns: 4n,
          response_end_ns: 5n,
        };
      },
      executeToolFn: async () => assert.fail("must not execute malformed tool"),
      tokenizeText: async () => ({ count: 0, provenance: "test" }),
    }),
    /MALFORMED_TOOL_CALL_AFTER_RETRY/,
  );
  assert.equal(attempts, 2);
});

test("one absolute deadline is propagated through model requests and tool actions", async () => {
  const remaining = [];
  let clock = 0n;
  const result = await runToolCase({
    phase: "sustained",
    caseId: "E-01",
    initialMessages: [{ role: "user", content: "fix" }],
    tools: [],
    sampling: { seed: 1, temperature: 0, top_p: 1, min_p: 0, top_k: 1 },
    reasoningFormat: "deepseek",
    model: "ornith-local",
    context: {},
    verifyRenderedPrompt: async () => contextBudget(1),
    streamRound: async ({ remainingTimeMs }) => {
      remaining.push(remainingTimeMs);
      clock += 1_000_000n;
      return {
        assistant: {
          reasoning_content: "",
          content: remaining.length === 1 ? null : "done",
          tool_calls: remaining.length === 1
            ? [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }]
            : [],
          timings: { prompt_n: 1, prompt_ms: 1, predicted_n: 1, predicted_ms: 1 },
          usage: {},
        },
        request_start_ns: 1n,
        request_sent_ns: 2n,
        first_sse_event_ns: 3n,
        first_output_ns: 4n,
        response_end_ns: 5n,
      };
    },
    executeToolFn: async (_context, _name, _input, { remainingTimeMs }) => {
      remaining.push(remainingTimeMs);
      clock += 1_000_000n;
      return { ok: true };
    },
    tokenizeText: async () => ({ count: 1, provenance: "test" }),
    nowNs: () => clock,
    maximumCaseMs: 10,
    absoluteDeadlineNs: 8_000_000n,
  });
  assert.equal(result.final_answer, "done");
  assert.deepEqual(remaining, [8, 7, 6]);
});
