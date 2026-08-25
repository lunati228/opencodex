import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { liveProcessEnvironment } from "../src/process-live.mjs";
import {
  buildHostMonitorArgv,
  parseTypeperfSample,
} from "../src/telemetry-live.mjs";
import { PINNED_WINDOWS_PROCESS_CONTROL } from "../src/windows-helper-trust.mjs";

const typeperf = path.join(
  PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root,
  "System32",
  "typeperf.exe",
);
const canTestHostTelemetry = process.platform === "win32" && existsSync(typeperf);

test(
  "pinned continuous host counters retain a stable real typeperf CSV shape",
  { skip: !canTestHostTelemetry },
  () => {
    const result = spawnSync(
      typeperf,
      buildHostMonitorArgv(3),
      {
        env: liveProcessEnvironment(),
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `typeperf failed: ${
        result.stderr?.trim() || result.error?.message || "unknown error"
      }`,
    );

    const csvLines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'));
    assert.equal(csvLines.length, 4);
    for (const line of csvLines.slice(1)) {
      const sample = parseTypeperfSample(
        csvLines[0],
        line,
        34_191_171_584,
      );
      assert.ok(Number.isFinite(sample.committed_pct));
      assert.ok(Number.isFinite(sample.available_bytes));
      assert.ok(Number.isFinite(sample.available_fraction));
    }
  },
);
