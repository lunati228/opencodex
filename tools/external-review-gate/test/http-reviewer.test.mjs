import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonHttpReviewer,
  parseBoundedJson,
} from "../src/http-reviewer.mjs";
import { CircuitBreaker } from "../src/resilience.mjs";

function streamedResponse(chunks, headers = {}) {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: {
      status: 200,
      headers: new Headers(headers),
      body,
    },
    wasCancelled: () => cancelled,
  };
}

test("provider-neutral HTTP adapter sends every request byte and no process environment", async () => {
  const requestBytes = Buffer.from(
    '{"version":1,"command":"synthetic command","cwd":"C:\\\\safe","timeoutMs":1000,"authLevel":"low"}',
    "utf8",
  );
  let captured;
  const reviewer = new JsonHttpReviewer({
    providerId: "synthetic-provider",
    endpoint: "https://reviewer.invalid/v1/review",
    headers: { Authorization: "Bearer SYNTHETIC_TOKEN" },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return streamedResponse([
        Buffer.from(
          JSON.stringify({
            decision: "allow",
            riskLevel: "low",
            authLevel: "medium",
            reasonCode: "SCOPED_ACTION",
          }),
        ),
      ]).response;
    },
  });
  const result = await reviewer.review({
    requestBytes,
    requestSha256: "1".repeat(64),
    commandSha256: "2".repeat(64),
    executableIdentitySha256: "4".repeat(64),
    cwdSha256: "3".repeat(64),
    requiredAuthLevel: "low",
    requestNonce: "5".repeat(32),
  });
  const body = JSON.parse(captured.init.body);
  assert.equal(captured.url, "https://reviewer.invalid/v1/review");
  assert.deepEqual(Buffer.from(body.requestBase64, "base64"), requestBytes);
  assert.equal(Object.hasOwn(body, "environment"), false);
  assert.equal(body.requestNonce, "5".repeat(32));
  assert.equal(result.decision, "allow");
});

test("provider-neutral HTTP adapter rejects an oversized response", async () => {
  const streamed = streamedResponse(
    [Buffer.alloc(70_000)],
    { "content-length": "70000" },
  );
  const reviewer = new JsonHttpReviewer({
    providerId: "synthetic-provider",
    endpoint: "https://reviewer.invalid/v1/review",
    fetchImpl: async () => streamed.response,
  });
  await assert.rejects(
    reviewer.review({
      requestBytes: Buffer.from("{}"),
      requestSha256: "1".repeat(64),
      commandSha256: "2".repeat(64),
      executableIdentitySha256: "4".repeat(64),
      cwdSha256: "3".repeat(64),
      requiredAuthLevel: "low",
      requestNonce: "5".repeat(32),
    }),
    /invalid response/i,
  );
});

test("chunked response without Content-Length cancels immediately on 64 KiB overflow", async () => {
  const streamed = streamedResponse([
    Buffer.alloc(40 * 1024, 0x20),
    Buffer.alloc(24 * 1024 + 1, 0x20),
    Buffer.from('{"must":"not be read"}'),
  ]);
  const reviewer = new JsonHttpReviewer({
    providerId: "synthetic-provider",
    endpoint: "https://reviewer.invalid/v1/review",
    fetchImpl: async () => streamed.response,
  });
  await assert.rejects(
    reviewer.review({
      requestBytes: Buffer.from("{}"),
      requestSha256: "1".repeat(64),
      commandSha256: "2".repeat(64),
      executableIdentitySha256: "4".repeat(64),
      cwdSha256: "3".repeat(64),
      requiredAuthLevel: "low",
      requestNonce: "5".repeat(32),
    }),
    /invalid response/i,
  );
  assert.equal(streamed.wasCancelled(), true);
});

test("streamed response accepts exactly 64 KiB and rejects 64 KiB plus one", async () => {
  const prefix = '{"value":"';
  const suffix = '"}';
  const exactText =
    prefix + "x".repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(exactText), 64 * 1024);
  const exact = streamedResponse([
    Buffer.from(exactText.slice(0, 30_000)),
    Buffer.from(exactText.slice(30_000)),
  ]);
  const parsed = await parseBoundedJson(exact.response);
  assert.equal(parsed.value.length, 64 * 1024 - prefix.length - suffix.length);

  const overflow = streamedResponse([Buffer.from(exactText), Buffer.from(" ")]);
  await assert.rejects(
    parseBoundedJson(overflow.response),
    /oversized/i,
  );
  assert.equal(overflow.wasCancelled(), true);
});

test("strict semantic response failures count against and open the circuit", async () => {
  let calls = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2 });
  const reviewer = new JsonHttpReviewer({
    providerId: "synthetic-provider",
    endpoint: "https://reviewer.invalid/v1/review",
    circuitBreaker: breaker,
    fetchImpl: async () => {
      calls += 1;
      return streamedResponse([
        Buffer.from(JSON.stringify({ decision: "allow" })),
      ]).response;
    },
  });
  const input = {
    requestBytes: Buffer.from("{}"),
    requestSha256: "1".repeat(64),
    commandSha256: "2".repeat(64),
    executableIdentitySha256: "4".repeat(64),
    cwdSha256: "3".repeat(64),
    requiredAuthLevel: "low",
    requestNonce: "5".repeat(32),
  };
  await assert.rejects(reviewer.review(input), /invalid response/i);
  await assert.rejects(reviewer.review(input), /invalid response/i);
  await assert.rejects(reviewer.review(input), /circuit/i);
  assert.equal(calls, 2);
});
