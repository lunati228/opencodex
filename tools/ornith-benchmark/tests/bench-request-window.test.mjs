import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchPlan } from "../src/bench-runner.mjs";
import { tempRoot } from "./temp-root.mjs";

test("request-in-flight covers only the exact benchmark process", async () => {
  const root = await tempRoot("ornith-bench-window-");
  const events = [];
  await runBenchPlan({
    plan: [{
      id: "pp2k",
      executable: process.execPath,
      args: [],
      expected_repetitions: 1,
    }],
    candidateRoot: root,
    cwd: root,
    requestWindow: async (action) => {
      events.push("on");
      try {
        return await action({
          setExpectedPid: (pid) => events.push(`pid:${pid}`),
          validateExpectedPidNow: async (pid) =>
            events.push(`validated:${pid}`),
        });
      } finally {
        events.push("off");
      }
    },
    runProcess: async ({ afterSpawn }) => {
      events.push("process");
      await afterSpawn(123);
      return {
        ok: true,
        stdout: JSON.stringify([{
          model_filename: "model.gguf",
          test: "pp2k",
          avg_ts: 1,
          samples_ts: [1],
          samples_ns: [1],
        }]),
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        exit_code: 0,
        duration_ms: 1,
        pid: 123,
        command: {},
      };
    },
  });
  assert.deepEqual(events, [
    "on",
    "process",
    "pid:123",
    "validated:123",
    "off",
  ]);
});
