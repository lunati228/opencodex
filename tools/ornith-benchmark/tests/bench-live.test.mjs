import assert from "node:assert/strict";
import test from "node:test";

import { parseBenchJson } from "../src/bench-live.mjs";

test("bench parser retains individual samples and derives robust finite summaries", () => {
  const parsed = parseBenchJson(JSON.stringify([
    {
      test: "tg256",
      samples_ts: [3, 5, 4],
      samples_ns: [10, 20, 15],
    },
  ]), { expectedRepetitions: 3 });
  assert.deepEqual(parsed.samples_ts, [3, 5, 4]);
  assert.deepEqual(parsed.samples_ns, [10, 20, 15]);
  assert.deepEqual(parsed.summary, {
    repetitions: 3,
    median_ts: 4,
    minimum_ts: 3,
    maximum_ts: 5,
    median_absolute_deviation_ts: 1,
    arithmetic_mean_ts: 4,
  });
});

test("bench parser rejects diagnostics, missing samples, and non-finite values", () => {
  assert.throws(() => parseBenchJson("log\n[]", { expectedRepetitions: 3 }), /INVALID_BENCH_JSON/);
  assert.throws(
    () => parseBenchJson(JSON.stringify([{ samples_ts: [1, 2], samples_ns: [1, 2] }]), { expectedRepetitions: 3 }),
    /BENCH_REPETITION_MISMATCH/,
  );
  assert.throws(
    () => parseBenchJson(JSON.stringify([{ samples_ts: [1, "NaN", 2], samples_ns: [1, 2, 3] }]), { expectedRepetitions: 3 }),
    /NONFINITE_BENCH_SAMPLE/,
  );
});
