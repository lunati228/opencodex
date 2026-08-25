import assert from "node:assert/strict";
import test from "node:test";

import {
  CircuitBreaker,
  parseRetryAfterMs,
  reviewWithRetry,
} from "../src/resilience.mjs";

function response(status, retryAfter) {
  return {
    status,
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
    async json() {
      return {
        decision: "allow",
        riskLevel: "low",
        authLevel: "medium",
        reasonCode: "SCOPED_ACTION",
      };
    },
  };
}

test("429 honors Retry-After and then succeeds", async () => {
  const waits = [];
  const replies = [response(429, "2"), response(200)];
  const result = await reviewWithRetry({
    send: async () => replies.shift(),
    sleep: async (milliseconds) => waits.push(milliseconds),
    maxAttempts: 3,
    maxDelayMs: 5_000,
    circuitBreaker: new CircuitBreaker({ failureThreshold: 5 }),
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(waits, [2_000]);
});

test("429 and 5xx response bodies are canceled before retry", async () => {
  const canceled = [];
  const errorResponse = (status) => ({
    ...response(status),
    body: {
      async cancel() {
        canceled.push(status);
      },
    },
  });
  const replies = [errorResponse(429), errorResponse(503), response(200)];
  const result = await reviewWithRetry({
    send: async () => replies.shift(),
    sleep: async () => {},
    maxAttempts: 3,
    circuitBreaker: new CircuitBreaker({ failureThreshold: 5 }),
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(canceled, [429, 503]);
});

test("hung error-body cancellation is independently bounded", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    reviewWithRetry({
      send: async () => ({
        ...response(503),
        body: {
          cancel: async () => new Promise(() => {}),
        },
      }),
      maxAttempts: 1,
      responseDisposalTimeoutMs: 10,
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5 }),
    }),
    /retry budget exhausted/i,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("Retry-After HTTP date is parsed relative to the injected clock", () => {
  const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
  assert.equal(
    parseRetryAfterMs("Fri, 24 Jul 2026 12:00:03 GMT", nowMs),
    3_000,
  );
});

test("backoff is bounded and circuit breaker stops repeated provider failure", async () => {
  let calls = 0;
  const waits = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 1_000,
  });
  await assert.rejects(
    reviewWithRetry({
      send: async () => {
        calls += 1;
        return response(503);
      },
      sleep: async (milliseconds) => waits.push(milliseconds),
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 750,
      circuitBreaker: breaker,
    }),
    /circuit/i,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
  await assert.rejects(
    reviewWithRetry({
      send: async () => response(200),
      circuitBreaker: breaker,
    }),
    /circuit/i,
  );
});

test("retry backoff sleep aborts promptly", async () => {
  const controller = new AbortController();
  const operation = reviewWithRetry({
    send: async () => response(429, "60"),
    sleep: async () => new Promise(() => {}),
    signal: controller.signal,
    circuitBreaker: new CircuitBreaker({ failureThreshold: 5 }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(operation, /aborted/i);
});
