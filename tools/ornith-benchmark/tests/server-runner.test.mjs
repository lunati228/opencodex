import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stopOrnithServer } from "../src/server-runner.mjs";
import { tempRoot } from "./temp-root.mjs";

test("server stop attempts bounded graceful shutdown before forced fallback", async () => {
  const root = await tempRoot("ornith-server-stop-");
  const order = [];
  const service = {
    command: {},
    closed: () => null,
    capture: () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdout_truncated: false,
      stderr_truncated: false,
    }),
  };
  await stopOrnithServer(
    { base_url: "http://127.0.0.1:1234", service },
    root,
    {
      requestGracefulShutdown: async () => {
        order.push("graceful");
        return false;
      },
      stopService: async () => {
        order.push("forced");
        return { code: 0 };
      },
    },
  );
  assert.deepEqual(order, ["graceful", "forced"]);
});
