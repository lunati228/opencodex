import assert from "node:assert/strict";
import test from "node:test";

import { SseAccumulator } from "../src/sse.mjs";

test("SSE parser preserves raw bytes, ignores ping timing, and requires terminal metrics and DONE", () => {
  let clock = 100n;
  const parser = new SseAccumulator({
    maxBytes: 4096,
    maxEvents: 10,
    nowNs: () => (clock += 10n),
  });
  parser.push(Buffer.from(": ping\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\r\n\r\n"));
  parser.push(Buffer.from("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"x\"}}]}\n\n"));
  parser.push(Buffer.from("data: {\"timings\":{\"prompt_n\":10,\"prompt_ms\":5,\"predicted_n\":2,\"predicted_ms\":4},\"usage\":{\"prompt_tokens\":10}}\n\ndata: [DONE]\n\n"));
  const result = parser.finish();
  assert.equal(result.events.length, 3);
  assert.equal(result.first_output_ns, 120n);
  assert.equal(result.terminal.timings.prompt_n, 10);
  assert.equal(result.done, true);
  assert.match(result.raw.toString("utf8"), /: ping/);
});

test("SSE parser enforces byte/event caps and rejects incomplete streams", () => {
  const capped = new SseAccumulator({ maxBytes: 4, maxEvents: 1 });
  assert.throws(() => capped.push(Buffer.from("12345")), /SSE_BYTE_CAP_EXCEEDED/);

  const missing = new SseAccumulator({ maxBytes: 1024, maxEvents: 4 });
  missing.push(Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"));
  assert.throws(() => missing.finish(), /SSE_TERMINAL_MISSING/);

  const overlongRecord = new SseAccumulator({
    maxBytes: 2 * 1024 * 1024,
    maxEvents: 1,
  });
  assert.throws(
    () => overlongRecord.push(Buffer.alloc(1024 * 1024 + 1, 0x78)),
    /SSE_PENDING_BUFFER_EXCEEDED/,
  );
});
