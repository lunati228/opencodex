import { spawn } from "node:child_process";
import path from "node:path";

import { liveProcessEnvironment } from "./process-live.mjs";
import {
  assertWindowsTreeToolsAvailable,
  startWindowsProcessFamilyTracker,
  terminateWindowsProcessTree,
} from "./windows-process-tree.mjs";

const FORBIDDEN_EXECUTABLES = new Set([
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "wsl.exe",
  "bash.exe",
  "sh.exe",
]);

function appendBounded(chunks, chunk, state) {
  const remaining = state.limit - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const portion = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(portion);
  state.bytes += portion.length;
  if (portion.length !== chunk.length) state.truncated = true;
}

export async function startPinnedService({
  executable,
  args,
  cwd,
  maxStdoutBytes = 64 * 1024 * 1024,
  maxStderrBytes = 64 * 1024 * 1024,
  onStdout,
  onStderr,
  terminationRuntime,
  moeCacheMode,
  moeCacheSettings,
  retainProcessFamily = false,
}) {
  if (
    typeof executable !== "string" ||
    !path.isAbsolute(executable) ||
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    throw new Error("INVALID_PINNED_SERVICE");
  }
  if (FORBIDDEN_EXECUTABLES.has(path.basename(executable).toLowerCase())) {
    throw new Error("FORBIDDEN_PINNED_SERVICE_EXECUTABLE");
  }
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, limit: maxStdoutBytes, truncated: false };
  const stderrState = { bytes: 0, limit: maxStderrBytes, truncated: false };
  const startedNs = process.hrtime.bigint();
  const environment = liveProcessEnvironment(process.env, {
    moeCacheMode,
    moeCacheSettings,
  });
  const terminationPlatform = terminationRuntime?.platform ?? process.platform;
  if (terminationPlatform === "win32" && retainProcessFamily) {
    await assertWindowsTreeToolsAvailable(environment);
  }
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    appendBounded(stdoutChunks, chunk, stdoutState);
    onStdout?.(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    appendBounded(stderrChunks, chunk, stderrState);
    onStderr?.(Buffer.from(chunk));
  });
  let closed = null;
  const closedPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = { code, signal, ended_ns: process.hrtime.bigint() };
      resolve(closed);
    });
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let familyTracker = null;
  if (terminationPlatform === "win32") {
    try {
      familyTracker = await startWindowsProcessFamilyTracker({
        child,
        environment,
        runtime: terminationRuntime,
      });
    } catch (error) {
      await terminateWindowsProcessTree({
        child,
        environment,
        runtime: terminationRuntime,
      });
      throw error;
    }
  }
  return {
    child,
    pid: child.pid,
    started_ns: startedNs,
    command: {
      executable,
      args: [...args],
      cwd,
      shell: false,
      environment: {
        ...(moeCacheMode === undefined
          ? {}
          : {
              GGML_CUDA_MOE_CACHE: moeCacheMode === "on" ? "1" : "0",
            }),
        ...(moeCacheSettings ?? {}),
      },
    },
    environment,
    terminationRuntime,
    familyTracker,
    closed: () => closed,
    wait: () => closedPromise,
    capture: () => ({
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
      stdout_truncated: stdoutState.truncated,
      stderr_truncated: stderrState.truncated,
    }),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopPinnedService(service, { graceMs = 30_000 } = {}) {
  if (service.closed()) {
    await service.familyTracker?.proveEmpty();
    return service.closed();
  }
  const platform =
    service.terminationRuntime?.platform ?? process.platform;
  if (platform === "win32") {
    let exit;
    let primaryError = null;
    try {
      exit = await terminateWindowsProcessTree({
        child: service.child,
        environment: service.environment,
        runtime: service.terminationRuntime,
      });
    } catch (error) {
      primaryError = error;
    }
    try {
      await service.familyTracker?.proveEmpty();
    } catch (error) {
      primaryError ??= error;
    }
    if (primaryError) throw primaryError;
    return exit;
  }
  service.child.kill("SIGTERM");
  const graceful = await Promise.race([
    service.wait().then((value) => ({ exited: true, value })),
    delay(graceMs).then(() => ({ exited: false })),
  ]);
  if (graceful.exited) return graceful.value;
  service.child.kill("SIGKILL");
  const forced = await Promise.race([
    service.wait().then((value) => ({ exited: true, value })),
    delay(5_000).then(() => ({ exited: false })),
  ]);
  if (!forced.exited) throw new Error("SERVICE_TERMINATION_FAILED");
  return forced.value;
}
