import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { liveProcessEnvironment } from "../src/process-live.mjs";
import { PINNED_WINDOWS_PROCESS_CONTROL } from "../src/windows-helper-trust.mjs";

const nvidiaSmi = path.join(
  PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root,
  "System32",
  "nvidia-smi.exe",
);
const canTestNvml = process.platform === "win32" && existsSync(nvidiaSmi);

test(
  "live sanitized Windows environment permits NVML initialization without exposing GPU UUIDs",
  { skip: !canTestNvml },
  () => {
    const result = spawnSync(
      nvidiaSmi,
      ["--query-gpu=index,name", "--format=csv,noheader,nounits"],
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
      `nvidia-smi failed under the live sanitized environment: ${
        result.stderr?.trim() || result.error?.message || "unknown error"
      }`,
    );
    assert.match(result.stdout, /^0, NVIDIA /m);
    assert.doesNotMatch(result.stdout, /GPU-[0-9a-f-]+/i);
  },
);
