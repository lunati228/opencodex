import { spawn } from "node:child_process";
import path from "node:path";

import { buildSanitizedEnvironment } from "./security.mjs";
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

const MOE_CACHE_SETTING_NAMES = new Set([
  "GGML_CUDA_MOE_CACHE_SELFTEST",
  "GGML_CUDA_MOE_CACHE_DEBUG",
  "GGML_CUDA_MOE_CACHE_FUSE",
  "GGML_CUDA_MOE_CACHE_REUSE",
  "GGML_CUDA_MOE_CACHE_REDIRECT",
  "GGML_CUDA_MOE_CACHE_PREFETCH",
  "GGML_CUDA_MOE_CACHE_HOTSET",
  "GGML_CUDA_MOE_CACHE_STATS",
  "GGML_CUDA_MOE_CACHE_RESERVE_MB",
  "GGML_CUDA_MOE_CACHE_NDEV",
  "GGML_CUDA_MOE_CACHE_INSERTS",
  "GGML_CUDA_MOE_CACHE_WORKERS",
  "GGML_CUDA_MOE_CACHE_THROTTLE",
  "GGML_CUDA_MOE_CACHE_MAX_BATCH",
  "GGML_CUDA_MOE_CACHE_MIN_EXPERT_KB",
]);

function validateProcessInput({
  executable,
  args,
  cwd,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  routerTracePath,
}) {
  if (
    typeof executable !== "string" ||
    !path.isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    throw new Error("INVALID_PINNED_PROCESS_COMMAND");
  }
  if (FORBIDDEN_EXECUTABLES.has(path.basename(executable).toLowerCase())) {
    throw new Error("FORBIDDEN_PINNED_PROCESS_EXECUTABLE");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("INVALID_PINNED_PROCESS_CWD");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45 * 60_000) {
    throw new Error("INVALID_PINNED_PROCESS_TIMEOUT");
  }
  for (const [name, value] of Object.entries({ maxStdoutBytes, maxStderrBytes })) {
    if (!Number.isInteger(value) || value < 1 || value > 64 * 1024 * 1024) {
      throw new Error(`INVALID_PINNED_PROCESS_CAP: ${name}`);
    }
  }
  if (
    routerTracePath !== undefined &&
    (typeof routerTracePath !== "string" ||
      !path.isAbsolute(routerTracePath) ||
      routerTracePath.length > 32_000 ||
      routerTracePath.includes("\0"))
  ) {
    throw new Error("INVALID_ROUTER_TRACE_PATH");
  }
}

function append(chunks, chunk, state) {
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

async function terminateExactProcessTree(
  child,
  environment,
  runtime = {},
) {
  const platform = runtime.platform ?? process.platform;
  if (platform === "win32") {
    return terminateWindowsProcessTree({
      child,
      environment,
      runtime,
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Direct PID termination remains mandatory.
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

export function liveProcessEnvironment(
  source = process.env,
  { moeCacheMode, moeCacheSettings } = {},
) {
  if (
    moeCacheMode !== undefined &&
    !["on", "off"].includes(moeCacheMode)
  ) {
    throw new Error("INVALID_MOE_CACHE_MODE");
  }
  if (
    moeCacheSettings !== undefined &&
    (
      moeCacheMode !== "on" ||
      moeCacheSettings === null ||
      typeof moeCacheSettings !== "object" ||
      Array.isArray(moeCacheSettings)
    )
  ) {
    throw new Error("INVALID_MOE_CACHE_SETTINGS");
  }
  const environment = {
    ...buildSanitizedEnvironment(source),
    LLAMA_ARG_OFFLINE: "1",
    CUDA_SCALE_LAUNCH_QUEUES: "4x",
    // Batches at or above this size copy CPU-resident weights to GPU for
    // prompt processing. The default of 32 is far too eager here: most of the
    // checkpoint lives host-side and the second GPU sits on a Gen3 x4 link, so
    // small batches pay a transfer that never amortizes. Pinned rather than
    // inherited so a parent environment cannot silently change a candidate.
    GGML_OP_OFFLOAD_MIN_BATCH: "512",
  };
  delete environment.GGML_CUDA_MOE_CACHE;
  if (moeCacheMode !== undefined) {
    environment.GGML_CUDA_MOE_CACHE = moeCacheMode === "on" ? "1" : "0";
  }
  for (const [name, value] of Object.entries(moeCacheSettings ?? {})) {
    if (
      !MOE_CACHE_SETTING_NAMES.has(name) ||
      typeof value !== "string" ||
      !/^\d+$/u.test(value)
    ) {
      throw new Error(`INVALID_MOE_CACHE_SETTING: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

export async function runPinnedProcess({
  executable,
  args,
  cwd,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  signal,
  onStdout,
  onStderr,
  terminationRuntime,
  routerTracePath,
  moeCacheMode,
  afterSpawn,
  retainProcessFamily = false,
}) {
  validateProcessInput({
    executable,
    args,
    cwd,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    routerTracePath,
  });
  if (signal?.aborted) throw new Error("COMMAND_ABORTED");
  const environment = liveProcessEnvironment(process.env, { moeCacheMode });
  if (routerTracePath !== undefined) {
    environment.GGML_ROUTER_TRACE_PATH = routerTracePath;
  }
  const terminationPlatform = terminationRuntime?.platform ?? process.platform;
  if (terminationPlatform === "win32") {
    await assertWindowsTreeToolsAvailable(environment);
  }
  const startedNs = process.hrtime.bigint();
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, limit: maxStdoutBytes, truncated: false };
  const stderrState = { bytes: 0, limit: maxStderrBytes, truncated: false };
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const close = new Promise((resolve) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, closeSignal) =>
      resolve({ code, closeSignal, spawnError }));
  });

  child.stdout.on("data", (chunk) => {
    append(stdoutChunks, chunk, stdoutState);
    onStdout?.(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    append(stderrChunks, chunk, stderrState);
    onStderr?.(Buffer.from(chunk));
  });
  let familyTracker = null;
  if (terminationPlatform === "win32" && retainProcessFamily) {
    try {
      familyTracker = await startWindowsProcessFamilyTracker({
        child,
        environment,
        runtime: terminationRuntime,
      });
    } catch (trackerError) {
      let cleanupError = null;
      try {
        await terminateExactProcessTree(child, environment, terminationRuntime);
      } catch (error) {
        cleanupError = error;
      }
      await close;
      if (cleanupError) throw cleanupError;
      throw trackerError;
    }
  }
  if (afterSpawn !== undefined) {
    if (typeof afterSpawn !== "function") {
      await terminateExactProcessTree(child, environment, terminationRuntime);
      await close;
      throw new Error("INVALID_AFTER_SPAWN_GUARD");
    }
    try {
      await afterSpawn(child.pid);
    } catch (error) {
      let cleanupError = null;
      try {
        await terminateExactProcessTree(child, environment, terminationRuntime);
      } catch (terminationError) {
        cleanupError = terminationError;
      }
      await close;
      try {
        await familyTracker?.proveEmpty();
      } catch (familyError) {
        cleanupError ??= familyError;
      }
      if (cleanupError) throw cleanupError;
      throw error;
    }
  }

  let termination = null;
  let terminationPromise = null;
  const terminate = (reason) => {
    if (termination === null) {
      termination = reason;
      terminationPromise = terminateExactProcessTree(
        child,
        environment,
        terminationRuntime,
      ).then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    }
  };
  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  const abort = () => terminate("aborted");
  signal?.addEventListener("abort", abort, { once: true });
  const { code, closeSignal, spawnError } = await close;
  const terminationResult = await terminationPromise;
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  let familyError = null;
  try {
    await familyTracker?.proveEmpty();
  } catch (error) {
    familyError = error;
  }
  if (terminationResult?.error) throw terminationResult.error;
  if (familyError) throw familyError;
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return {
    ok: spawnError === null && termination === null && code === 0,
    error_code: spawnError
      ? "SPAWN_ERROR"
      : termination === "timeout"
        ? "COMMAND_TIMEOUT"
        : termination === "aborted"
          ? "COMMAND_ABORTED"
          : code === 0
            ? null
            : "NONZERO_EXIT",
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout_truncated: stdoutState.truncated,
    stderr_truncated: stderrState.truncated,
    exit_code: code,
    signal: closeSignal,
    duration_ms: Math.round(durationMs * 1000) / 1000,
    pid: child.pid ?? null,
    command: {
      executable,
      args: [...args],
      cwd,
      shell: false,
      environment: {
        ...(routerTracePath === undefined
          ? {}
          : { GGML_ROUTER_TRACE_PATH: routerTracePath }),
        ...(moeCacheMode === undefined
          ? {}
          : {
              GGML_CUDA_MOE_CACHE: moeCacheMode === "on" ? "1" : "0",
            }),
      },
    },
  };
}
