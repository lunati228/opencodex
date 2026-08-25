import assert from "node:assert/strict";
import test from "node:test";

import {
  parseComputeApplications,
  validateExpectedGpuProcessSet,
} from "../src/gpu-process-guard.mjs";

test("GPU process guard accepts only the expected PID on every declared GPU", () => {
  const rows = parseComputeApplications(
    "123, GPU-A\r\n123, GPU-B\r\n",
  );
  assert.deepEqual(rows, [
    { pid: 123, gpu_uuid: "GPU-A" },
    { pid: 123, gpu_uuid: "GPU-B" },
  ]);
  assert.doesNotThrow(() =>
    validateExpectedGpuProcessSet(rows, 123, ["GPU-A", "GPU-B"]));
  assert.throws(
    () =>
      validateExpectedGpuProcessSet(
        [...rows, { pid: 999, gpu_uuid: "GPU-A" }],
        123,
        ["GPU-A", "GPU-B"],
      ),
    /COMPETING_GPU_PROCESS_DETECTED/,
  );
  assert.throws(
    () => validateExpectedGpuProcessSet(rows.slice(0, 1), 123, ["GPU-A", "GPU-B"]),
    /EXPECTED_GPU_PROCESS_COVERAGE_MISSING/,
  );
});
