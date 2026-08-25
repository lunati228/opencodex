import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPinnedWindowsRoot,
  PINNED_WINDOWS_PROCESS_CONTROL,
  validateWindowsProcessControl,
} from "./windows-helper-trust.mjs";

const TYPEPERF_ARGUMENTS = Object.freeze([
  "\\Process(*)\\ID Process",
  "\\Process(*)\\Creating Process ID",
  "\\Process(*)\\Elapsed Time",
  "-sc",
  "1",
]);
const SYSTEM_COMMAND_TIMEOUT_MS = 5_000;
const SYSTEM_COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROCESS_IDENTITY_TOLERANCE_MS = 2_000;
const STABLE_EMPTY_SNAPSHOTS = 3;
const MAX_VERIFICATION_SNAPSHOTS = 8;

function codedError(code, detail, cause) {
  const error = new Error(detail ? `${code}: ${detail}` : code, {
    cause,
  });
  error.code = code;
  return error;
}

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

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      closed: true,
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve(value);
    };
    const onError = (error) => finish({ closed: true, error });
    const onClose = (code, signal) =>
      finish({ closed: true, code, signal });
    const timer = setTimeout(() => finish({ closed: false }), timeoutMs);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function defaultSystemCommandRunner({
  executable,
  args,
  environment,
  timeoutMs,
  maxOutputBytes,
}) {
  const child = spawn(executable, args, {
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0, limit: maxOutputBytes, truncated: false };
  const stderrState = { bytes: 0, limit: maxOutputBytes, truncated: false };
  child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState));
  child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, stderrState));
  const result = await waitForClose(child, timeoutMs);
  if (!result.closed) {
    child.kill("SIGKILL");
    await waitForClose(child, timeoutMs);
  }
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout_truncated: stdoutState.truncated,
    stderr_truncated: stderrState.truncated,
  };
}

function configuredSystemRoot(environment, policy) {
  const entry = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  );
  const value = entry?.[1];
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes("\0")
  ) {
    throw codedError("TRUSTED_SYSTEM32_PATH_UNAVAILABLE");
  }
  const normalized = path.win32.normalize(value);
  if (
    normalized.toLowerCase() !== value.replace(/[\\]+$/, "").toLowerCase() &&
    `${normalized}\\`.toLowerCase() !== value.toLowerCase()
  ) {
    throw codedError("TRUSTED_SYSTEM32_PATH_UNAVAILABLE");
  }
  if (
    normalized.replace(/[\\]+$/, "").toLowerCase() !==
    canonicalPinnedWindowsRoot(policy).toLowerCase()
  ) {
    throw codedError("TRUSTED_SYSTEM32_ROOT_MISMATCH");
  }
  return canonicalPinnedWindowsRoot(policy);
}

export function trustedWindowsTreeExecutables(
  environment,
  policy = PINNED_WINDOWS_PROCESS_CONTROL,
) {
  validateWindowsProcessControl(policy);
  const system32 = path.win32.join(
    configuredSystemRoot(environment, policy),
    "System32",
  );
  return Object.freeze({
    taskkill: path.win32.join(system32, "taskkill.exe"),
    typeperf: path.win32.join(system32, "typeperf.exe"),
  });
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() ===
    path.win32.normalize(right).toLowerCase();
}

async function assertOrdinaryDirectory(directoryPath) {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw codedError(
      "TRUSTED_WINDOWS_TREE_DIRECTORY_INVALID",
      directoryPath,
    );
  }
  const canonical = await realpath(directoryPath);
  if (!sameWindowsPath(canonical, directoryPath)) {
    throw codedError(
      "TRUSTED_WINDOWS_TREE_DIRECTORY_REPARSE_REJECTED",
      directoryPath,
    );
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function hashStableOpenFile(filePath, expectedBytes) {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== BigInt(expectedBytes)
    ) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_UNAVAILABLE",
        filePath,
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - position),
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      position !== Number(before.size) ||
      !sameFileIdentity(before, afterHandle) ||
      !sameFileIdentity(before, afterPath)
    ) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_IDENTITY_MISMATCH",
        filePath,
      );
    }
    return { digest: digest.digest("hex"), metadata: before };
  } finally {
    await handle.close();
  }
}

export async function assertWindowsTreeToolsAvailable(
  environment,
  policy = PINNED_WINDOWS_PROCESS_CONTROL,
) {
  const validated = validateWindowsProcessControl(policy);
  const executables = trustedWindowsTreeExecutables(environment, validated);
  const expectedRoot = canonicalPinnedWindowsRoot(validated);
  await assertOrdinaryDirectory(expectedRoot);
  await assertOrdinaryDirectory(path.win32.join(expectedRoot, "System32"));
  for (const [name, filePath] of Object.entries(executables)) {
    const evidence = validated.helpers[name];
    let pathMetadata;
    try {
      pathMetadata = await lstat(filePath, { bigint: true });
    } catch (error) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_UNAVAILABLE",
        `${name}=${filePath}`,
        error,
      );
    }
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.size !== BigInt(evidence.bytes)
    ) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_UNAVAILABLE",
        `${name}=${filePath}`,
      );
    }
    const canonical = await realpath(filePath);
    if (!sameWindowsPath(canonical, filePath)) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_REPARSE_REJECTED",
        `${name}=${filePath}`,
      );
    }
    const verified = await hashStableOpenFile(filePath, evidence.bytes);
    if (
      verified.digest !== evidence.sha256 ||
      !sameFileIdentity(pathMetadata, verified.metadata)
    ) {
      throw codedError(
        "TRUSTED_WINDOWS_TREE_TOOL_IDENTITY_MISMATCH",
        `${name}=${filePath}`,
      );
    }
  }
  return executables;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      if (value.length !== 0) {
        throw codedError("WINDOWS_PROCESS_SNAPSHOT_INVALID", "malformed CSV");
      }
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) {
    throw codedError("WINDOWS_PROCESS_SNAPSHOT_INVALID", "unterminated CSV");
  }
  values.push(value);
  return values;
}

function counterDescriptor(header) {
  const match =
    /\\Process\(([^)]+)\)\\(ID Process|Creating Process ID|Elapsed Time)$/i.exec(
      header,
    );
  if (!match) return null;
  return {
    instance: match[1],
    counter: match[2].toLowerCase(),
  };
}

export function parseTypeperfProcessSnapshot(stdout, capturedAtMs = Date.now()) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > SYSTEM_COMMAND_OUTPUT_LIMIT) {
    throw codedError("WINDOWS_PROCESS_SNAPSHOT_INVALID", "invalid output");
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const headerIndex = lines.findIndex((line) =>
    line.includes("(PDH-CSV"),
  );
  if (headerIndex < 0 || headerIndex + 1 >= lines.length) {
    throw codedError("WINDOWS_PROCESS_SNAPSHOT_INVALID", "missing CSV sample");
  }
  const headers = parseCsvLine(lines[headerIndex]);
  const sample = parseCsvLine(lines[headerIndex + 1]);
  if (headers.length !== sample.length || headers.length < 2) {
    throw codedError("WINDOWS_PROCESS_SNAPSHOT_INVALID", "column mismatch");
  }
  const byInstance = new Map();
  for (let index = 1; index < headers.length; index += 1) {
    const descriptor = counterDescriptor(headers[index]);
    if (!descriptor) continue;
    const record = byInstance.get(descriptor.instance) ?? {
      instance: descriptor.instance,
    };
    if (Object.hasOwn(record, descriptor.counter)) {
      throw codedError(
        "WINDOWS_PROCESS_SNAPSHOT_INVALID",
        `duplicate counter for ${descriptor.instance}`,
      );
    }
    record[descriptor.counter] = Number(sample[index]);
    byInstance.set(descriptor.instance, record);
  }
  const records = [];
  const seenPids = new Set();
  for (const record of byInstance.values()) {
    if (record.instance.toLowerCase() === "_total") continue;
    const pid = record["id process"];
    const parentPid = record["creating process id"];
    const elapsedSeconds = record["elapsed time"];
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 0
    ) {
      continue;
    }
    if (pid <= 0) continue;
    if (seenPids.has(pid)) {
      throw codedError(
        "WINDOWS_PROCESS_SNAPSHOT_INVALID",
        `duplicate PID ${pid}`,
      );
    }
    seenPids.add(pid);
    records.push({
      pid,
      parentPid,
      instance: record.instance,
      elapsedSeconds,
      startedAtEstimateMs: capturedAtMs - elapsedSeconds * 1_000,
    });
  }
  return {
    capturedAtMs,
    records: records.sort((left, right) => left.pid - right.pid),
  };
}

function validateCommandResult(result, operation) {
  if (
    !result ||
    result.closed !== true ||
    result.error ||
    result.code !== 0 ||
    result.stdout_truncated ||
    result.stderr_truncated ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw codedError(
      "WINDOWS_SYSTEM_COMMAND_FAILED",
      `${operation}: code=${String(result?.code)} signal=${String(result?.signal)} closed=${String(result?.closed)} stdout=${JSON.stringify(result?.stdout ?? "")} stderr=${JSON.stringify(result?.stderr ?? "")}`,
      result?.error,
    );
  }
}

async function runSystemCommand(runtime, input) {
  const runner = runtime.systemCommandRunner ?? defaultSystemCommandRunner;
  return runner({
    ...input,
    timeoutMs: SYSTEM_COMMAND_TIMEOUT_MS,
    maxOutputBytes: SYSTEM_COMMAND_OUTPUT_LIMIT,
  });
}

async function captureSnapshot(environment, executables, runtime) {
  let result;
  try {
    result = await runSystemCommand(runtime, {
      executable: executables.typeperf,
      args: [...TYPEPERF_ARGUMENTS],
      environment,
    });
  } catch (error) {
    throw codedError(
      "WINDOWS_PROCESS_SNAPSHOT_FAILED",
      error.message,
      error,
    );
  }
  validateCommandResult(result, "typeperf process snapshot");
  return parseTypeperfProcessSnapshot(result.stdout);
}

function sameProcessIdentity(expected, actual) {
  return (
    expected.pid === actual.pid &&
    Math.abs(expected.startedAtEstimateMs - actual.startedAtEstimateMs) <=
      PROCESS_IDENTITY_TOLERANCE_MS
  );
}

function exactTree(snapshot, rootPid) {
  const byPid = new Map(snapshot.records.map((record) => [record.pid, record]));
  const root = byPid.get(rootPid);
  if (!root) {
    throw codedError(
      "WINDOWS_PROCESS_ROOT_NOT_IN_SNAPSHOT",
      String(rootPid),
    );
  }
  const output = [{ ...root, depth: 0 }];
  const known = new Set([rootPid]);
  for (let index = 0; index < output.length; index += 1) {
    const parent = output[index];
    for (const record of snapshot.records) {
      if (record.parentPid !== parent.pid) continue;
      if (known.has(record.pid)) {
        throw codedError(
          "WINDOWS_PROCESS_TREE_INVALID",
          `cycle or duplicate PID ${record.pid}`,
        );
      }
      known.add(record.pid);
      output.push({ ...record, depth: parent.depth + 1 });
    }
  }
  return output;
}

function observeKnownFamily(knownByPid, snapshot, rootPid) {
  const currentByPid = new Map(
    snapshot.records.map((record) => [record.pid, record]),
  );
  for (const expected of knownByPid.values()) {
    const actual = currentByPid.get(expected.pid);
    if (actual && !sameProcessIdentity(expected, actual)) {
      throw codedError(
        "WINDOWS_PROCESS_IDENTITY_CHANGED",
        String(expected.pid),
      );
    }
  }

  const depths = new Map([[rootPid, 0]]);
  for (const record of knownByPid.values()) {
    depths.set(record.pid, record.depth);
  }
  let added = true;
  while (added) {
    added = false;
    for (const record of snapshot.records) {
      if (depths.has(record.pid) || !depths.has(record.parentPid)) continue;
      const depth = depths.get(record.parentPid) + 1;
      depths.set(record.pid, depth);
      const existing = knownByPid.get(record.pid);
      if (existing && !sameProcessIdentity(existing, record)) {
        throw codedError(
          "WINDOWS_PROCESS_IDENTITY_CHANGED",
          String(record.pid),
        );
      }
      knownByPid.set(record.pid, { ...record, depth });
      added = true;
    }
  }

  const currentRoot = currentByPid.get(rootPid);
  if (currentRoot && !knownByPid.has(rootPid)) {
    knownByPid.set(rootPid, { ...currentRoot, depth: 0 });
  }
  const lingering = [...knownByPid.values()].filter((expected) => {
    const actual = currentByPid.get(expected.pid);
    return actual && sameProcessIdentity(expected, actual);
  });
  return lingering;
}

function killObservedProcesses(records) {
  let killError = null;
  for (const record of [...records].sort(
    (left, right) => right.depth - left.depth || right.pid - left.pid,
  )) {
    try {
      process.kill(record.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") killError ??= error;
    }
  }
  if (killError) {
    throw codedError(
      "WINDOWS_DIRECT_TREE_TERMINATION_FAILED",
      `pids=${records.map(({ pid }) => pid).join(",")}`,
      killError,
    );
  }
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitForObservedExit(records, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (records.every(({ pid }) => !pidExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const lingering = records.filter(({ pid }) => pidExists(pid));
  if (lingering.length > 0) {
    throw codedError(
      "WINDOWS_DIRECT_TREE_TERMINATION_FAILED",
      `lingering=${lingering.map(({ pid }) => pid).join(",")}`,
    );
  }
}

async function cleanupAndProveStableEmpty({
  knownByPid,
  rootPid,
  environment,
  executables,
  runtime,
}) {
  let stableEmpty = 0;
  let observedAfterTaskkill = false;
  for (
    let scan = 0;
    scan < MAX_VERIFICATION_SNAPSHOTS;
    scan += 1
  ) {
    const snapshot = await captureSnapshot(environment, executables, runtime);
    const lingering = observeKnownFamily(knownByPid, snapshot, rootPid);
    if (lingering.length === 0) {
      stableEmpty += 1;
      if (stableEmpty >= STABLE_EMPTY_SNAPSHOTS) {
        return {
          observed_after_taskkill: observedAfterTaskkill,
          known_pids: [...knownByPid.keys()].sort((left, right) => left - right),
          verification_snapshots: scan + 1,
        };
      }
      continue;
    }
    observedAfterTaskkill = true;
    stableEmpty = 0;
    killObservedProcesses(lingering);
    await waitForObservedExit(lingering);
  }
  throw codedError(
    "WINDOWS_PROCESS_TREE_STABLE_EMPTY_UNPROVEN",
    `known=${[...knownByPid.keys()].sort((left, right) => left - right).join(",")}`,
  );
}

export async function startWindowsProcessFamilyTracker({
  child,
  environment,
  runtime = {},
  pollMs = 5_000,
}) {
  const executables = await assertWindowsTreeToolsAvailable(
    environment,
    runtime.windowsProcessControl,
  );
  let initialTree = null;
  let initialError = null;
  for (let attempt = 0; attempt < 100 && initialTree === null; attempt += 1) {
    try {
      const initial = await captureSnapshot(environment, executables, runtime);
      initialTree = exactTree(initial, child.pid);
    } catch (error) {
      if (error.code !== "WINDOWS_PROCESS_ROOT_NOT_IN_SNAPSHOT") {
        throw error;
      }
      initialError = error;
      if (attempt < 99) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
  if (initialTree === null) throw initialError;
  const knownByPid = new Map(
    initialTree.map((record) => [record.pid, record]),
  );
  let stopped = false;
  let polling = Promise.resolve();
  let pollingError = null;
  const observe = async () => {
    if (stopped || pollingError) return;
    try {
      const snapshot = await captureSnapshot(environment, executables, runtime);
      observeKnownFamily(knownByPid, snapshot, child.pid);
    } catch (error) {
      pollingError = error;
    }
  };
  const timer = setInterval(() => {
    polling = polling.then(observe);
  }, pollMs);
  timer.unref?.();
  return {
    async proveEmpty() {
      if (stopped) throw codedError("WINDOWS_PROCESS_TRACKER_ALREADY_STOPPED", "");
      stopped = true;
      clearInterval(timer);
      await polling;
      if (pollingError) throw pollingError;
      const proof = await cleanupAndProveStableEmpty({
        knownByPid,
        rootPid: child.pid,
        environment,
        executables,
        runtime,
      });
      if (proof.observed_after_taskkill) {
        throw codedError(
          "WINDOWS_DESCENDANT_SURVIVED_ROOT_EXIT",
          `known=${proof.known_pids.join(",")}`,
        );
      }
      return proof;
    },
  };
}

async function runTaskkill(rootPid, environment, executables, runtime) {
  return runSystemCommand(runtime, {
    executable: executables.taskkill,
    args: ["/PID", String(rootPid), "/T", "/F"],
    environment,
  });
}

function taskkillSucceeded(result) {
  return (
    result?.closed === true &&
    !result.error &&
    result.code === 0 &&
    !result.stdout_truncated &&
    !result.stderr_truncated
  );
}

export async function terminateWindowsProcessTree({
  child,
  environment,
  runtime = {},
}) {
  const executables = await assertWindowsTreeToolsAvailable(
    environment,
    runtime.windowsProcessControl,
  );
  const knownByPid = new Map();
  let initialError = null;
  try {
    const before = await captureSnapshot(environment, executables, runtime);
    for (const record of exactTree(before, child.pid)) {
      knownByPid.set(record.pid, record);
    }
  } catch (error) {
    initialError = error;
  }

  let taskkillResult;
  let taskkillError = null;
  try {
    taskkillResult = await runTaskkill(
      child.pid,
      environment,
      executables,
      runtime,
    );
  } catch (error) {
    taskkillError = error;
  }
  let proof = null;
  let cleanupError = null;
  try {
    proof = await cleanupAndProveStableEmpty({
      knownByPid,
      rootPid: child.pid,
      environment,
      executables,
      runtime,
    });
  } catch (error) {
    cleanupError = error;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  const taskkillOk = !taskkillError && taskkillSucceeded(taskkillResult);
  if (
    initialError ||
    !taskkillOk ||
    cleanupError ||
    proof?.observed_after_taskkill
  ) {
    throw codedError(
      "TASKKILL_TREE_TERMINATION_FAILED",
      `initial_snapshot=${initialError ? "uncertain" : "valid"} taskkill_code=${String(taskkillResult?.code)} taskkill_signal=${String(taskkillResult?.signal)} taskkill_closed=${String(taskkillResult?.closed)} observed_after_taskkill=${String(proof?.observed_after_taskkill ?? false)} known=${proof?.known_pids?.join(",") ?? ""}`,
      cleanupError ??
        initialError ??
        taskkillError ??
        taskkillResult?.error,
    );
  }
  const rootExit = await waitForClose(child, SYSTEM_COMMAND_TIMEOUT_MS);
  if (!rootExit.closed) {
    throw codedError("TASKKILL_ROOT_CLOSE_UNCONFIRMED");
  }
  return rootExit;
}
