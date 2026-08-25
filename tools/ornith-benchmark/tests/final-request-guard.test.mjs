import assert from "node:assert/strict";
import test from "node:test";

import { runMonitoredRequest } from "../src/final-live-runner.mjs";

function abortBoundRequest(controller, setup = () => {}) {
  return (context) =>
    new Promise((resolve, reject) => {
      setup(context);
      const timer = setTimeout(() => resolve("late success"), 1_000);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(controller.signal.reason);
      }, { once: true });
    });
}

test("request guard continuously rejects a competing GPU process after dispatch", async () => {
  const controller = new AbortController();
  let gpuChecks = 0;
  let spaceChecks = 0;
  await assert.rejects(
    runMonitoredRequest({
      request: abortBoundRequest(controller),
      initialExpectedPid: 123,
      validateExpectedPid: async () => {
        gpuChecks += 1;
        if (gpuChecks >= 2) {
          throw new Error("COMPETING_GPU_PROCESS_DETECTED");
        }
      },
      verifyFreeSpace: async () => {
        spaceChecks += 1;
      },
      controller,
      intervalMs: 5,
    }),
    /COMPETING_GPU_PROCESS_DETECTED/,
  );
  assert.ok(gpuChecks >= 2);
  assert.ok(spaceChecks >= 2);
});

test("request guard continuously rejects result-volume exhaustion", async () => {
  const controller = new AbortController();
  let spaceChecks = 0;
  await assert.rejects(
    runMonitoredRequest({
      request: abortBoundRequest(controller, ({ setExpectedPid }) => {
        setExpectedPid(456);
      }),
      validateExpectedPid: async () => {},
      verifyFreeSpace: async () => {
        spaceChecks += 1;
        if (spaceChecks >= 2) {
          throw new Error("INSUFFICIENT_RESULT_VOLUME_SPACE");
        }
      },
      controller,
      intervalMs: 5,
    }),
    /INSUFFICIENT_RESULT_VOLUME_SPACE/,
  );
  assert.ok(spaceChecks >= 2);
});

test("transient benchmark coverage is proven before process close without a post-close PID query", async () => {
  const controller = new AbortController();
  let processAlive = false;
  let gpuChecks = 0;
  const value = await runMonitoredRequest({
    request: async ({ setExpectedPid, validateExpectedPidNow }) => {
      processAlive = true;
      setExpectedPid(789);
      await validateExpectedPidNow(789);
      processAlive = false;
      return "complete";
    },
    validateExpectedPid: async () => {
      gpuChecks += 1;
      assert.equal(processAlive, true);
      if (!processAlive) {
        throw new Error("EXPECTED_GPU_PROCESS_COVERAGE_MISSING");
      }
    },
    verifyFreeSpace: async () => {},
    controller,
    intervalMs: 1_000,
  });
  assert.equal(value, "complete");
  assert.equal(gpuChecks, 1);
});
