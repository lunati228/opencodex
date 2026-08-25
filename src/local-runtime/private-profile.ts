import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { LocalRuntimeProfileId } from "../types";

export const PRIVATE_LOCAL_RUNTIME_PROFILE_ENV =
  "OPENCODEX_LOCAL_RUNTIME_PROFILE";
const PRIVATE_LOCAL_RUNTIME_PROFILE_FILE = "local-runtime.private.json";
const MAX_PRIVATE_PROFILE_BYTES = 128 * 1024;

const PRIVATE_PROFILE_KEYS = new Set([
  "schemaVersion",
  "profileId",
  "releaseRoot",
  "executablePath",
  "modelPath",
  "projectorPath",
  "expectedExecutableBytes",
  "expectedExecutableSha256",
  "expectedModelBytes",
  "expectedProjectorBytes",
  "expectedBuildNumber",
  "expectedBuildCommit",
  "serverPredictionLimit",
  "launchArgs",
  "environment",
  "measuredTokensPerSecond",
  "measurementNote",
]);

const RESERVED_LAUNCH_FLAGS = new Set([
  "--model",
  "-m",
  "--mmproj",
  "--host",
  "--port",
  "--alias",
  "--ctx-size",
  "-c",
  "--n-predict",
  "-n",
  "--parallel",
  "-np",
  "--reasoning",
  "--reasoning-effort",
]);

const PRIVATE_ENVIRONMENT_KEYS = new Set([
  "LLAMA_ARG_OFFLINE",
  "CUDA_SCALE_LAUNCH_QUEUES",
]);

export interface PrivateLocalRuntimeProfile {
  readonly schemaVersion: 1;
  readonly profileId: LocalRuntimeProfileId;
  readonly releaseRoot: string;
  readonly executablePath: string;
  readonly modelPath: string;
  readonly projectorPath: string;
  readonly expectedExecutableBytes: number;
  readonly expectedExecutableSha256: string;
  readonly expectedModelBytes: number;
  readonly expectedProjectorBytes: number;
  readonly expectedBuildNumber: string;
  readonly expectedBuildCommit: string;
  readonly serverPredictionLimit: number;
  readonly launchArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly measuredTokensPerSecond: number;
  readonly measurementNote: string;
}

function invalid(): never {
  throw new Error("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, max = 4096): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\0\r\n]/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPrivateAbsolutePath(value: unknown): value is string {
  return isBoundedString(value) && win32.isAbsolute(value);
}

function executableBelongsToReleaseRoot(
  releaseRoot: string,
  executablePath: string,
): boolean {
  const relative = win32.relative(
    win32.resolve(releaseRoot),
    win32.resolve(executablePath),
  );
  return relative.length > 0
    && !win32.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${win32.sep}`);
}

function validateLaunchArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) invalid();
  const args = value.map(arg => {
    if (!isBoundedString(arg)) invalid();
    const flag = arg.slice(0, arg.indexOf("=") < 0 ? undefined : arg.indexOf("="))
      .toLowerCase();
    if (RESERVED_LAUNCH_FLAGS.has(flag)) invalid();
    return arg;
  });
  return Object.freeze(args);
}

function validateEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) invalid();
  const environment: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!PRIVATE_ENVIRONMENT_KEYS.has(key) || !isBoundedString(raw, 1024)) invalid();
    environment[key] = raw;
  }
  return Object.freeze(environment);
}

export function parsePrivateLocalRuntimeProfile(
  text: string,
  expectedProfileId: string,
): PrivateLocalRuntimeProfile {
  if (Buffer.byteLength(text, "utf8") > MAX_PRIVATE_PROFILE_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!isRecord(parsed)) invalid();
  if (Object.keys(parsed).some(key => !PRIVATE_PROFILE_KEYS.has(key))) invalid();
  if (parsed.schemaVersion !== 1 || parsed.profileId !== expectedProfileId) invalid();
  if (
    !isPrivateAbsolutePath(parsed.releaseRoot)
    || !isPrivateAbsolutePath(parsed.executablePath)
    || !isPrivateAbsolutePath(parsed.modelPath)
    || !isPrivateAbsolutePath(parsed.projectorPath)
    || !executableBelongsToReleaseRoot(parsed.releaseRoot, parsed.executablePath)
  ) invalid();
  if (
    !isPositiveSafeInteger(parsed.expectedExecutableBytes)
    || !isPositiveSafeInteger(parsed.expectedModelBytes)
    || !isPositiveSafeInteger(parsed.expectedProjectorBytes)
    || typeof parsed.expectedExecutableSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(parsed.expectedExecutableSha256)
    || !isBoundedString(parsed.expectedBuildNumber, 128)
    || !isBoundedString(parsed.expectedBuildCommit, 128)
    || !isSafeInteger(parsed.serverPredictionLimit)
    || parsed.serverPredictionLimit < -1
    || typeof parsed.measuredTokensPerSecond !== "number"
    || !Number.isFinite(parsed.measuredTokensPerSecond)
    || parsed.measuredTokensPerSecond < 0
    || !isBoundedString(parsed.measurementNote, 4096)
  ) invalid();

  return Object.freeze({
    schemaVersion: 1,
    profileId: parsed.profileId as LocalRuntimeProfileId,
    releaseRoot: parsed.releaseRoot,
    executablePath: parsed.executablePath,
    modelPath: parsed.modelPath,
    projectorPath: parsed.projectorPath,
    expectedExecutableBytes: parsed.expectedExecutableBytes,
    expectedExecutableSha256: parsed.expectedExecutableSha256,
    expectedModelBytes: parsed.expectedModelBytes,
    expectedProjectorBytes: parsed.expectedProjectorBytes,
    expectedBuildNumber: parsed.expectedBuildNumber,
    expectedBuildCommit: parsed.expectedBuildCommit,
    serverPredictionLimit: parsed.serverPredictionLimit,
    launchArgs: validateLaunchArgs(parsed.launchArgs),
    environment: validateEnvironment(parsed.environment),
    measuredTokensPerSecond: parsed.measuredTokensPerSecond,
    measurementNote: parsed.measurementNote,
  });
}

function expandHomePrefix(value: string, userHome: string): string {
  if (value === "~") return userHome;
  if (value.startsWith("~\\") || value.startsWith("~/")) {
    return win32.join(userHome, value.slice(2));
  }
  return value;
}

export function resolvePrivateLocalRuntimeProfilePath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  cwd = process.cwd(),
): string {
  const explicit = env[PRIVATE_LOCAL_RUNTIME_PROFILE_ENV]?.trim();
  if (explicit) return win32.resolve(cwd, expandHomePrefix(explicit, userHome));
  const configuredHome = env.OPENCODEX_HOME?.trim();
  const configHome = configuredHome
    ? win32.resolve(cwd, expandHomePrefix(configuredHome, userHome))
    : win32.join(userHome, ".opencodex");
  return win32.join(configHome, PRIVATE_LOCAL_RUNTIME_PROFILE_FILE);
}

export function loadPrivateLocalRuntimeProfile(
  expectedProfileId: LocalRuntimeProfileId,
  env: NodeJS.ProcessEnv = process.env,
): PrivateLocalRuntimeProfile {
  let text: string;
  try {
    text = readFileSync(resolvePrivateLocalRuntimeProfilePath(env), "utf8");
  } catch {
    throw new Error("LOCAL_RUNTIME_PRIVATE_PROFILE_MISSING");
  }
  return parsePrivateLocalRuntimeProfile(text.replace(/^\uFEFF/, ""), expectedProfileId);
}
