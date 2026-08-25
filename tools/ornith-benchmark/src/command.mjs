import { spawn } from "node:child_process";

import {
  assertAllowedCommand,
  buildSanitizedEnvironment,
} from "./security.mjs";

function appendBounded(chunks, chunk, state) {
  const remaining = state.limit - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const portion =
    chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(portion);
  state.bytes += portion.length;
  if (portion.length !== chunk.length) state.truncated = true;
}

export async function runAllowlistedCommand({
  command,
  allowlist,
  cwd,
  timeoutMs,
  maxOutputBytes,
  stdin,
}) {
  const approved = assertAllowedCommand(command, allowlist);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 360_000) {
    throw new Error("INVALID_TIMEOUT");
  }
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16 * 1024 * 1024
  ) {
    throw new Error("INVALID_OUTPUT_CAP");
  }
  if (
    stdin !== undefined &&
    !(
      typeof stdin === "string" ||
      Buffer.isBuffer(stdin)
    )
  ) {
    throw new Error("INVALID_COMMAND_STDIN");
  }
  if (
    stdin !== undefined &&
    Buffer.byteLength(stdin) > 1024 * 1024
  ) {
    throw new Error("COMMAND_STDIN_TOO_LARGE");
  }

  const start = process.hrtime.bigint();
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, limit: maxOutputBytes, truncated: false };
  const stderrState = { bytes: 0, limit: maxOutputBytes, truncated: false };

  const child = spawn(approved.executable, approved.args, {
    cwd,
    env: buildSanitizedEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  child.stdout.on("data", (chunk) =>
    appendBounded(stdoutChunks, chunk, stdoutState),
  );
  child.stderr.on("data", (chunk) =>
    appendBounded(stderrChunks, chunk, stderrState),
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const { code, signal, spawnError } = await new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
  });
  clearTimeout(timer);
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    ok: !spawnError && !timedOut && code === 0,
    error_code: spawnError
      ? "SPAWN_ERROR"
      : timedOut
        ? "COMMAND_TIMEOUT"
        : code === 0
          ? null
          : "NONZERO_EXIT",
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exit_code: code,
    signal,
    duration_ms: Math.round(durationMs * 1000) / 1000,
    stdout_truncated: stdoutState.truncated,
    stderr_truncated: stderrState.truncated,
    command: {
      id: approved.id,
      executable: approved.executable,
      args: [...approved.args],
      cwd,
      shell: false,
    },
  };
}
