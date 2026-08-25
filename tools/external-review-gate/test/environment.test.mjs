import assert from "node:assert/strict";
import test from "node:test";

import { buildAllowedEnvironment } from "../src/environment.mjs";

test("environment construction is a strict allowlist", () => {
  const result = buildAllowedEnvironment({
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    OPENAI_API_KEY: "synthetic-secret",
    RANDOM_UNRECOGNIZED: "must-not-pass",
    NODE_OPTIONS: "--require malicious.js",
  });
  assert.deepEqual(result, {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
  });
});
