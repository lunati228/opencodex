import { runPinnedProcess } from "./process-live.mjs";

export function parseComputeApplications(stdout) {
  if (typeof stdout !== "string") {
    throw new Error("GPU_PROCESS_QUERY_INVALID");
  }
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split(",").map((value) => value.trim());
    const pid = Number(fields[0]);
    if (
      fields.length !== 2 ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !/^GPU-[A-Za-z0-9-]+$/.test(fields[1])
    ) {
      throw new Error("GPU_PROCESS_QUERY_INVALID");
    }
    rows.push({ pid, gpu_uuid: fields[1] });
  }
  return rows;
}

export function validateExpectedGpuProcessSet(
  rows,
  expectedPid,
  expectedGpuUuids,
) {
  if (
    !Number.isSafeInteger(expectedPid) ||
    expectedPid < 1 ||
    !Array.isArray(expectedGpuUuids) ||
    expectedGpuUuids.length < 1
  ) {
    throw new Error("EXPECTED_GPU_PROCESS_IDENTITY_INVALID");
  }
  const expected = new Set(expectedGpuUuids);
  if (
    rows.some(({ pid, gpu_uuid: uuid }) =>
      pid !== expectedPid || !expected.has(uuid))
  ) {
    throw new Error("COMPETING_GPU_PROCESS_DETECTED");
  }
  const observed = new Set(rows.map(({ gpu_uuid: uuid }) => uuid));
  if (
    observed.size !== expected.size ||
    [...expected].some((uuid) => !observed.has(uuid))
  ) {
    throw new Error("EXPECTED_GPU_PROCESS_COVERAGE_MISSING");
  }
  return true;
}

export async function queryExclusiveExpectedGpuProcess({
  nvidiaSmi,
  cwd,
  expectedPid,
  expectedGpuUuids,
  signal,
  query = runPinnedProcess,
}) {
  const result = await query({
    executable: nvidiaSmi,
    args: [
      "--query-compute-apps=pid,gpu_uuid",
      "--format=csv,noheader,nounits",
    ],
    cwd,
    timeoutMs: 15_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    signal,
  });
  if (!result.ok || result.stdout_truncated || result.stderr_truncated) {
    throw new Error("GPU_PROCESS_QUERY_FAILED");
  }
  validateExpectedGpuProcessSet(
    parseComputeApplications(result.stdout),
    expectedPid,
    expectedGpuUuids,
  );
  return { expected_pid: expectedPid, gpu_uuids: [...expectedGpuUuids] };
}

export async function waitForExclusiveExpectedGpuProcess({
  nvidiaSmi,
  cwd,
  expectedPid,
  expectedGpuUuids,
  signal,
  maximumWaitMs = 30_000,
  query = runPinnedProcess,
  delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = Date.now() + maximumWaitMs;
  let lastCoverageError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("COMMAND_ABORTED");
    try {
      return await queryExclusiveExpectedGpuProcess({
        nvidiaSmi,
        cwd,
        expectedPid,
        expectedGpuUuids,
        signal,
        query,
      });
    } catch (error) {
      if (error.message !== "EXPECTED_GPU_PROCESS_COVERAGE_MISSING") throw error;
      lastCoverageError = error;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw lastCoverageError ?? new Error("EXPECTED_GPU_PROCESS_COVERAGE_MISSING");
}
