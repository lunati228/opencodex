import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export const AUTH_LEVELS = Object.freeze(["low", "medium", "high"]);
export const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_ARGV_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
export const REQUEST_NONCE = /^[0-9a-f]{32}$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function executableMetadata(metadata) {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    modifiedNs: metadata.mtimeNs.toString(),
  };
}

async function executableContentSha256(canonicalPath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(canonicalPath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function executableIdentity(executable) {
  const canonicalPath = await realpath(executable);
  const metadataBefore = await stat(canonicalPath, { bigint: true });
  if (!metadataBefore.isFile()) {
    throw new Error("request executable must be a regular file");
  }
  const contentSha256 = await executableContentSha256(canonicalPath);
  const metadataAfter = await stat(canonicalPath, { bigint: true });
  if (
    !metadataAfter.isFile() ||
    canonicalJson(executableMetadata(metadataBefore)) !==
      canonicalJson(executableMetadata(metadataAfter))
  ) {
    throw new Error("request executable changed while its identity was measured");
  }
  const identity = {
    path: canonicalPath,
    ...executableMetadata(metadataAfter),
    contentSha256,
  };
  return {
    canonicalPath,
    sha256: sha256(Buffer.from(canonicalJson(identity), "utf8")),
  };
}

function pathTextMatchesCanonical(input, canonicalPath) {
  return process.platform === "win32"
    ? input.toLowerCase() === canonicalPath.toLowerCase()
    : input === canonicalPath;
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export async function parseRequestBytes(requestBytes, { projectRoot }) {
  if (!Buffer.isBuffer(requestBytes)) {
    throw new TypeError("requestBytes must be a Buffer");
  }
  if (requestBytes.length === 0 || requestBytes.length > MAX_REQUEST_BYTES) {
    throw new Error("request bytes are empty or oversized");
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("request bytes are not valid UTF-8 JSON");
  }
  if (
    !hasExactKeys(value, [
      "version",
      "executable",
      "argv",
      "cwd",
      "timeoutMs",
      "authLevel",
      "requestNonce",
    ])
  ) {
    throw new Error("request has the wrong fields");
  }
  const canonicalRequestBytes = Buffer.from(
    JSON.stringify({
      version: value.version,
      executable: value.executable,
      argv: value.argv,
      cwd: value.cwd,
      timeoutMs: value.timeoutMs,
      authLevel: value.authLevel,
      requestNonce: value.requestNonce,
    }),
    "utf8",
  );
  if (!canonicalRequestBytes.equals(requestBytes)) {
    throw new Error("request must use canonical JSON.stringify encoding");
  }
  if (value.version !== 1) {
    throw new Error("request version is unsupported");
  }
  if (
    typeof value.executable !== "string" ||
    !path.isAbsolute(value.executable) ||
    value.executable.includes("\0") ||
    !Array.isArray(value.argv) ||
    !value.argv.every(
      (argument) => typeof argument === "string" && !argument.includes("\0"),
    ) ||
    Buffer.byteLength(JSON.stringify(value.argv), "utf8") > MAX_ARGV_BYTES
  ) {
    throw new Error("request executable or argv is invalid or oversized");
  }
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("request timeout is invalid");
  }
  if (!AUTH_LEVELS.includes(value.authLevel)) {
    throw new Error("request authorization level is invalid");
  }
  if (
    typeof value.requestNonce !== "string" ||
    !REQUEST_NONCE.test(value.requestNonce)
  ) {
    throw new Error("request nonce must be exactly 128 bits of lowercase hex");
  }
  if (typeof value.cwd !== "string" || value.cwd.length === 0) {
    throw new Error("request cwd is invalid");
  }
  const canonicalRoot = await realpath(projectRoot);
  const canonicalCwd = await realpath(value.cwd);
  const executable = await executableIdentity(value.executable);
  if (!pathTextMatchesCanonical(value.executable, executable.canonicalPath)) {
    throw new Error("request executable must use its canonical executable path");
  }
  if (!pathTextMatchesCanonical(value.cwd, canonicalCwd)) {
    throw new Error("request cwd must use its canonical cwd path");
  }
  if (!isPathInside(canonicalCwd, canonicalRoot)) {
    throw new Error("request cwd resolves outside the project root");
  }
  return Object.freeze({
    version: 1,
    executable: executable.canonicalPath,
    argv: Object.freeze([...value.argv]),
    cwd: canonicalCwd,
    timeoutMs: value.timeoutMs,
    authLevel: value.authLevel,
    requestNonce: value.requestNonce,
    projectRoot: canonicalRoot,
    requestSha256: sha256(requestBytes),
    commandSha256: sha256(
      Buffer.from(
        canonicalJson({
          executable: executable.canonicalPath,
          argv: value.argv,
        }),
        "utf8",
      ),
    ),
    executableIdentitySha256: executable.sha256,
    cwdSha256: sha256(Buffer.from(canonicalCwd, "utf8")),
  });
}

export function validateReviewResult(value) {
  if (
    !hasExactKeys(value, [
      "decision",
      "riskLevel",
      "authLevel",
      "reasonCode",
    ])
  ) {
    throw new Error("review result has the wrong fields");
  }
  if (!["allow", "deny"].includes(value.decision)) {
    throw new Error("review decision is invalid");
  }
  if (!RISK_LEVELS.includes(value.riskLevel)) {
    throw new Error("review risk level is invalid");
  }
  if (!AUTH_LEVELS.includes(value.authLevel)) {
    throw new Error("review authorization level is invalid");
  }
  if (
    typeof value.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.reasonCode)
  ) {
    throw new Error("review reason code is invalid");
  }
  if (value.decision === "allow" && value.riskLevel === "critical") {
    throw new Error("critical actions cannot be approved");
  }
  if (
    value.decision === "allow" &&
    value.riskLevel === "high" &&
    AUTH_LEVELS.indexOf(value.authLevel) < AUTH_LEVELS.indexOf("medium")
  ) {
    throw new Error("high-risk action lacks sufficient authorization");
  }
  return Object.freeze({ ...value });
}
