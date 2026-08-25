import path from "node:path";

import { appendRawArtifact } from "./artifacts.mjs";
import { parseBenchJson } from "./bench-live.mjs";
import { runPinnedProcess } from "./process-live.mjs";

function workloadDirectory(candidateRoot, id) {
  return id === "pp2k" || id === "tg256-d2k"
    ? path.join(candidateRoot, "sweep")
    : path.join(candidateRoot, "final");
}

export async function runBenchPlan({
  plan,
  candidateRoot,
  cwd,
  signal,
  timeoutMs = 45 * 60_000,
  moeCacheMode = "off",
  requestWindow = (action) => action({ setExpectedPid: () => {} }),
  runProcess = runPinnedProcess,
  validateExpectedPid,
}) {
  const completed = [];
  for (const workload of plan) {
    const directory = workloadDirectory(candidateRoot, workload.id);
    const rawPath = path.join(directory, `${workload.id}.raw.json`);
    const stderrPath = path.join(directory, `${workload.id}.stderr.txt`);
    const commandPath = path.join(directory, `${workload.id}.command.json`);
    const result = await requestWindow(({
      setExpectedPid,
      validateExpectedPidNow,
    } = {}) =>
      runProcess({
        executable: workload.executable,
        args: workload.args,
        cwd,
        timeoutMs,
        maxStdoutBytes: 64 * 1024 * 1024,
        maxStderrBytes: 16 * 1024 * 1024,
        signal,
        moeCacheMode,
        retainProcessFamily: true,
        afterSpawn: async (pid) => {
          setExpectedPid?.(pid);
          if (validateExpectedPidNow) {
            await validateExpectedPidNow(pid);
          } else if (validateExpectedPid) {
            await validateExpectedPid(pid);
          }
        },
      }),
    );
    await Promise.all([
      appendRawArtifact(rawPath, Buffer.from(result.stdout, "utf8")),
      appendRawArtifact(stderrPath, Buffer.from(result.stderr, "utf8")),
      appendRawArtifact(
        commandPath,
        Buffer.from(`${JSON.stringify(result.command, null, 2)}\n`, "utf8"),
      ),
    ]);
    if (!result.ok) throw new Error(`BENCH_PROCESS_FAILED: ${workload.id}:${result.error_code}`);
    if (result.stdout_truncated || result.stderr_truncated) {
      throw new Error(`BENCH_OUTPUT_TRUNCATED: ${workload.id}`);
    }
    const parsed = parseBenchJson(result.stdout, {
      expectedRepetitions: workload.expected_repetitions,
    });
    completed.push({
      id: workload.id,
      raw_path: rawPath,
      stderr_path: stderrPath,
      command_path: commandPath,
      process: {
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        pid: result.pid,
      },
      samples_ts: parsed.samples_ts,
      samples_ns: parsed.samples_ns,
      summary: parsed.summary,
    });
  }
  return completed;
}
