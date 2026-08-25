import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLoopbackTarget,
  buildChatRequest,
  parseSlotEraseResponse,
  parseTokenizeResponse,
  verifyContextBudget,
  verifyHealthResponse,
  verifyModelIdentity,
} from "../src/loopback.mjs";

test("only literal loopback HTTP targets are accepted", () => {
  assert.deepEqual(assertLoopbackTarget("http://127.0.0.1:8088/health"), {
    hostname: "127.0.0.1",
    port: 8088,
    path: "/health",
  });
  for (const url of [
    "https://127.0.0.1:8088/health",
    "http://localhost:8088/health",
    "http://127.0.0.2:8088/health",
    "http://127.0.0.1:8088@evil.example/health",
  ]) {
    assert.throws(() => assertLoopbackTarget(url), /NON_LOOPBACK_TARGET|INVALID_LOOPBACK_PROTOCOL/);
  }
});

test("health, model identity, tokenize, and slot erasure are validated", () => {
  assert.deepEqual(verifyHealthResponse(200, { status: "ok" }), { status: "ok" });
  assert.equal(verifyModelIdentity(
    { data: [{ id: "ornith-local" }] },
    "ornith-local",
  ).id, "ornith-local");
  assert.deepEqual(parseTokenizeResponse(200, { tokens: [1, 2, 3] }), {
    count: 3,
    provenance: "llama-server-b10099-/tokenize",
  });
  assert.equal(verifyContextBudget(7168, 1024, 8192).fits, true);
  assert.throws(() => verifyContextBudget(7169, 1024, 8192), /CONTEXT_BUDGET_EXCEEDED/);
  assert.deepEqual(parseSlotEraseResponse(200, { id_slot: 0, n_erased: 12 }), {
    id_slot: 0,
    n_erased: 12,
  });
  assert.throws(() => parseSlotEraseResponse(200, { id_slot: 1, n_erased: 0 }), /SLOT_ERASE_VERIFICATION_FAILED/);
});

test("chat request is exact, canonical, cache-aware, and schema-sorted", () => {
  const request = buildChatRequest({
    model: "ornith-local",
    messages: [{ role: "user", content: "fix it" }],
    tools: [
      { type: "function", function: { name: "z", parameters: {} } },
      { type: "function", function: { name: "a", parameters: {} } },
    ],
    firstRound: true,
    sampling: { seed: 7, temperature: 0.2, top_p: 0.9, min_p: 0.05, top_k: 20 },
    reasoningFormat: "deepseek",
  });
  assert.deepEqual(request.value.tools.map((tool) => tool.function.name), ["a", "z"]);
  assert.equal(request.value.cache_prompt, false);
  assert.equal(request.value.parallel_tool_calls, false);
  assert.equal(request.value.max_tokens, 1024);
  assert.equal(request.bytes.toString("utf8"), JSON.stringify(request.value));
});
