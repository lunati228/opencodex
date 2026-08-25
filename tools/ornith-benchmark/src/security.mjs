import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { PINNED_WINDOWS_PROCESS_CONTROL } from "./windows-helper-trust.mjs";

const FORBIDDEN_EXECUTABLES = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "wsl",
  "wsl.exe",
]);

function securityError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function normalizedForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function resolveContainedPath(rootPath, requestedPath) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw securityError("INVALID_PATH", "path must be a non-empty string");
  }

  const realRoot = await realpath(rootPath);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(realRoot, requestedPath);
  if (
    !isInside(
      normalizedForComparison(realRoot),
      normalizedForComparison(candidate),
    )
  ) {
    throw securityError("PATH_ESCAPE", requestedPath);
  }

  const relative = path.relative(realRoot, candidate);
  let cursor = realRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        const resolvedLink = await realpath(cursor);
        if (
          !isInside(
            normalizedForComparison(realRoot),
            normalizedForComparison(resolvedLink),
          )
        ) {
          throw securityError("REPARSE_ESCAPE", requestedPath);
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

function executableName(executable) {
  return path.basename(executable).toLowerCase();
}

function sameExecutable(left, right) {
  if (path.isAbsolute(left) || path.isAbsolute(right)) {
    return normalizedForComparison(left) === normalizedForComparison(right);
  }
  return left.toLowerCase() === right.toLowerCase();
}

export function assertAllowedCommand(command, allowlist) {
  if (
    !command ||
    typeof command.executable !== "string" ||
    !Array.isArray(command.args) ||
    !command.args.every((argument) => typeof argument === "string")
  ) {
    throw securityError("INVALID_COMMAND", "expected executable and argv array");
  }
  if (FORBIDDEN_EXECUTABLES.has(executableName(command.executable))) {
    throw securityError("FORBIDDEN_EXECUTABLE", command.executable);
  }
  const match = allowlist.find(
    (allowed) =>
      sameExecutable(command.executable, allowed.executable) &&
      command.args.length === allowed.args.length &&
      command.args.every((argument, index) => argument === allowed.args[index]),
  );
  if (!match) {
    throw securityError(
      "COMMAND_NOT_ALLOWLISTED",
      `${command.executable} ${command.args.join(" ")}`,
    );
  }
  return structuredClone(match);
}

export function buildSanitizedEnvironment(source = process.env) {
  const environment = {
    ORNITH_NETWORK_DISABLED: "1",
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    npm_config_offline: "true",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    SystemRoot: PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root,
    WINDIR: PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root,
    ProgramFiles: path.win32.join(
      path.win32.parse(PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root).root,
      "Program Files",
    ),
  };
  for (const name of [
    "PATH",
    "Path",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (typeof source[name] === "string") {
      environment[name] = source[name];
    }
  }
  return environment;
}

export function assertSafeCaseId(caseId) {
  if (!/^[A-Z]-\d{2}$/.test(caseId)) {
    throw securityError("INVALID_CASE_ID", String(caseId));
  }
  return caseId;
}
