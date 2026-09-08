import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { freemem } from "node:os";
import { parse, resolve, sep } from "node:path";
import { isPortAvailable } from "../server/ports";
import {
  saveConfigPreservingClaudeCode,
} from "../config";
import type { OcxConfig } from "../types";
import {
  LOCAL_RUNTIME_IDLE_SWEEP_MS,
  clearLocalRuntimeUse,
  ensureLocalRuntimeReady,
  localRuntimeLastUsedAt,
  localRuntimeActiveUseCount,
  shouldReleaseIdleLocalRuntime,
  type EnsureReadyResult,
} from "./on-demand";
import {
  buildLocalRuntimeArgs,
  buildLocalRuntimeEnvironment,
  getLocalRuntimeProfile,
  isManagedLocalProviderProjection,
  LOCAL_RUNTIME_HOST,
  LOCAL_RUNTIME_PORT,
  LOCAL_RUNTIME_PROFILE_ID,
  LOCAL_RUNTIME_PROVIDER_ID,
  managedLocalProviderProjection,
  validateLocalRuntimeCandidate,
  type LocalRuntimeCandidate,
  type LocalRuntimeProfileId,
} from "./profile";
import {
  loadPrivateLocalRuntimeProfile,
  type PrivateLocalRuntimeProfile,
} from "./private-profile";
import {
  LocalRuntimeSupervisor,
  type LocalRuntimeEffective,
  type LocalRuntimeHandle,
  type LocalRuntimeStatus,
  type LocalRuntimeSupervisorDeps,
} from "./supervisor";
import { managedLocalRuntimeConsumerLeases } from "./consumer-leases";

const STARTUP_DEADLINE_MS = 15 * 60 * 1000;
const POLL_MS = 2_000;
const PROBE_TIMEOUT_MS = 3_000;
const BYTES_PER_MIB = 1024 * 1024;
const verifiedPrivateProfiles = new Map<
  LocalRuntimeProfileId,
  PrivateLocalRuntimeProfile
>();

function assertOrdinaryPath(path: string, expectedKind: "file" | "directory"): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = current === root ? `${root}${component}` : `${current}${sep}${component}`;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("LOCAL_RUNTIME_PATH_UNSAFE");
  }
  const stat = lstatSync(absolute);
  if (
    (expectedKind === "file" && !stat.isFile())
    || (expectedKind === "directory" && !stat.isDirectory())
  ) {
    throw new Error("LOCAL_RUNTIME_PATH_INVALID");
  }
  if (realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) {
    throw new Error("LOCAL_RUNTIME_PATH_REDIRECTED");
  }
}

/**
 * Verify the engine and the selected model before launching.
 *
 * The model identity comes from the profile rather than a module constant: a
 * single shared constant is what silently went stale during an earlier
 * default-model switch, which would have failed every launch.
 */
function assertProfileFiles(
  profileId: LocalRuntimeProfileId = LOCAL_RUNTIME_PROFILE_ID,
): void {
  getLocalRuntimeProfile(profileId);
  const privateProfile = loadPrivateLocalRuntimeProfile(profileId);
  assertOrdinaryPath(privateProfile.releaseRoot, "directory");
  assertOrdinaryPath(privateProfile.executablePath, "file");
  assertOrdinaryPath(privateProfile.modelPath, "file");
  assertOrdinaryPath(privateProfile.projectorPath, "file");
  const server = lstatSync(privateProfile.executablePath);
  const model = lstatSync(privateProfile.modelPath);
  const projector = lstatSync(privateProfile.projectorPath);
  if (
    server.size !== privateProfile.expectedExecutableBytes
    || model.size !== privateProfile.expectedModelBytes
    || projector.size !== privateProfile.expectedProjectorBytes
  ) {
    throw new Error("LOCAL_RUNTIME_FILE_IDENTITY_MISMATCH");
  }
  const hash = createHash("sha256")
    .update(readFileSync(privateProfile.executablePath))
    .digest("hex");
  if (hash !== privateProfile.expectedExecutableSha256) {
    throw new Error("LOCAL_RUNTIME_BINARY_IDENTITY_MISMATCH");
  }
  verifiedPrivateProfiles.set(profileId, privateProfile);
}

function verifiedPrivateProfile(
  profileId: LocalRuntimeProfileId,
): PrivateLocalRuntimeProfile {
  const privateProfile = verifiedPrivateProfiles.get(profileId);
  if (!privateProfile) {
    throw new Error("LOCAL_RUNTIME_PRIVATE_PROFILE_NOT_VERIFIED");
  }
  return privateProfile;
}

export function hasMinimumAvailableHostMemory(
  availableBytes: number,
  minimumAvailableMemoryMiB: number | undefined,
): boolean {
  return minimumAvailableMemoryMiB === undefined
    || (
      Number.isFinite(availableBytes)
      && availableBytes >= minimumAvailableMemoryMiB * BYTES_PER_MIB
    );
}

function assertHostMemoryAvailable(profileId: LocalRuntimeProfileId): void {
  const { minimumAvailableMemoryMiB } = verifiedPrivateProfile(profileId);
  if (!hasMinimumAvailableHostMemory(freemem(), minimumAvailableMemoryMiB)) {
    throw new Error("LOCAL_RUNTIME_HOST_MEMORY_LOW");
  }
}

/**
 * Read and discard. The pipes must be consumed -- an undrained stdout or stderr
 * fills its buffer and blocks llama-server mid-load -- but nothing reads the
 * text back, so nothing is accumulated. See BACKLOG P41: the startup-log
 * capture this replaces was write-only, so it cost memory and told no one
 * anything.
 */
function drain(stream: NodeJS.ReadableStream): void {
  stream.resume();
}

function spawnHandle(candidate: LocalRuntimeCandidate): Promise<LocalRuntimeHandle> {
  const privateProfile = verifiedPrivateProfile(candidate.profileId);
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(
      privateProfile.executablePath,
      buildLocalRuntimeArgs(candidate, privateProfile),
      {
        cwd: privateProfile.releaseRoot,
        // The profile-selected environment is deliberately minimal and omits
        // inherited provider credentials.
        env: buildLocalRuntimeEnvironment(privateProfile, process.env),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    drain(child.stdout);
    drain(child.stderr);

    let settledExit = false;
    let resolveExit!: (
      value: { code: number | null; signal: NodeJS.Signals | null },
    ) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      resolve => { resolveExit = resolve; },
    );
    const settleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settledExit) return;
      settledExit = true;
      resolveExit({ code, signal });
    };
    child.once("exit", settleExit);
    child.once("error", () => settleExit(null, null));

    const onError = (): void => {
      rejectLaunch(new Error("LOCAL_RUNTIME_SPAWN_FAILED"));
    };
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      const pid = child.pid;
      if (!pid) {
        rejectLaunch(new Error("LOCAL_RUNTIME_SPAWN_FAILED"));
        return;
      }
      let terminating: Promise<void> | null = null;
      resolveLaunch({
        pid,
        exited,
        terminate(): Promise<void> {
          if (terminating) return terminating;
          terminating = (async () => {
            if (child.exitCode !== null || child.signalCode !== null) {
              await exited;
              return;
            }
            child.kill("SIGTERM");
            const graceful = await Promise.race([
              exited.then(() => true),
              Bun.sleep(10_000).then(() => false),
            ]);
            if (!graceful && child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
              const forced = await Promise.race([
                exited.then(() => true),
                Bun.sleep(5_000).then(() => false),
              ]);
              if (!forced) {
                throw new Error("LOCAL_RUNTIME_TERMINATION_FAILED");
              }
            }
          })();
          return terminating;
        },
      });
    });
  });
}

function fixedEndpoint(path: string): string {
  return `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}${path}`;
}

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(fixedEndpoint(path), {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("LOCAL_RUNTIME_NOT_READY");
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LOCAL_RUNTIME_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function listenerPid(): number | null {
  if (process.platform !== "win32") return null;
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const output = execFileSync(`${systemRoot}\\System32\\netstat.exe`, [
      "-ano",
      "-p",
      "tcp",
    ], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (
        fields.length >= 5
        && fields[0]?.toUpperCase() === "TCP"
        && fields[1] === `${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}`
        && fields[3]?.toUpperCase() === "LISTENING"
      ) {
        const pid = Number(fields[4]);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeWindowsPath(path: string): string {
  return resolve(path).replace(/\//g, "\\").toLowerCase();
}

/** Capability evidence from `/props` only; callers must separately verify runtime identity. */
export function hasReadyLocalRuntimeVision(props: Record<string, unknown>): boolean {
  const modalities = props.modalities;
  return props.is_sleeping === false
    && modalities !== null
    && typeof modalities === "object"
    && !Array.isArray(modalities)
    && (modalities as { vision?: unknown }).vision === true;
}

async function probe(
  handle: LocalRuntimeHandle,
  candidate: LocalRuntimeCandidate,
): Promise<LocalRuntimeEffective> {
  // Identity is checked against the profile that was actually launched.
  const profile = getLocalRuntimeProfile(candidate.profileId);
  const privateProfile = verifiedPrivateProfile(candidate.profileId);
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  let exited = false;
  void handle.exited.then(() => { exited = true; });
  while (Date.now() < deadline) {
    assertHostMemoryAvailable(candidate.profileId);
    if (exited) throw new Error("LOCAL_RUNTIME_READINESS_FAILED");
    let identityVerified = false;
    let supportsVision = false;
    try {
      const health = await fetch(fixedEndpoint("/health"), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (health.ok) {
        const [models, props] = await Promise.all([
          fetchJson("/v1/models"),
          fetchJson("/props"),
        ]);
        const data = models.data;
        const modelFound = Array.isArray(data) && data.some(entry =>
          entry && typeof entry === "object"
          && (entry as { id?: unknown }).id === profile.modelId
        );
        const generation = props.default_generation_settings;
        const nCtx = generation && typeof generation === "object"
          ? (generation as { n_ctx?: unknown }).n_ctx
          : undefined;
        const buildInfo = props.build_info;
        const modelPath = props.model_path;
        const ownerPid = listenerPid();
        identityVerified = Boolean(
          modelFound
          && nCtx === candidate.nCtx
          && props.total_slots === 1
          && typeof buildInfo === "string"
          && buildInfo.includes(privateProfile.expectedBuildNumber)
          && buildInfo.includes(privateProfile.expectedBuildCommit)
          && typeof modelPath === "string"
          && normalizeWindowsPath(modelPath) === normalizeWindowsPath(privateProfile.modelPath)
          && (process.platform !== "win32" || ownerPid === handle.pid)
          && !exited
        );
        supportsVision = identityVerified && hasReadyLocalRuntimeVision(props);
      }
    } catch {
      // Loading returns non-200 health and transient connection errors.
    }
    if (identityVerified) {
      assertHostMemoryAvailable(candidate.profileId);
      if (exited) throw new Error("LOCAL_RUNTIME_READINESS_FAILED");
      return {
        ...candidate,
        model: profile.modelId,
        verifiedAt: new Date().toISOString(),
        supportsVision,
      };
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error("LOCAL_RUNTIME_READINESS_FAILED");
}

function persistLastKnownGood(
  config: OcxConfig,
  candidate: LocalRuntimeCandidate,
  verifiedAt: string,
): void {
  config.localRuntime = {
    enabled: true,
    autoStart: config.localRuntime?.autoStart !== false,
    ...candidate,
    verifiedAt,
  };
  const profile = getLocalRuntimeProfile(candidate.profileId);
  config.providers[profile.providerId] = managedLocalProviderProjection(
    candidate.nCtx,
    candidate.profileId,
  );
  saveConfigPreservingClaudeCode(config);
}

export const productionLocalRuntimeDeps: LocalRuntimeSupervisorDeps = {
  now: Date.now,
  consumers: managedLocalRuntimeConsumerLeases,
  activeUseCount: localRuntimeActiveUseCount,
  assertProfileFiles,
  assertHostMemoryAvailable,
  isPortFree: () => isPortAvailable(LOCAL_RUNTIME_PORT, LOCAL_RUNTIME_HOST),
  launch: spawnHandle,
  probe,
  persistLastKnownGood,
};

const managedSupervisor = new LocalRuntimeSupervisor(productionLocalRuntimeDeps);

export function getManagedLocalRuntimeSupervisor(): LocalRuntimeSupervisor {
  return managedSupervisor;
}

export function managedLocalRuntimeCanRoute(): boolean {
  return managedSupervisor.canRoute();
}

export type ManagedLocalRuntimeReadyOperation =
  | { kind: "start"; candidate: LocalRuntimeCandidate }
  | {
    kind: "apply";
    candidate: LocalRuntimeCandidate;
    expectedRevision: number;
  };

/**
 * Choose the one supervisor mutation an on-demand request should attempt.
 *
 * `requestApply` carries rollback semantics. Using it with no owned child made
 * a cold local request load the candidate and then load the same last-known-good
 * model again after any post-readiness failure. A stopped supervisor must use
 * the cold-start path, while a live child at a different context still needs an
 * owned restart through apply.
 */
export function selectManagedLocalRuntimeReadyOperation(
  config: OcxConfig,
  status: LocalRuntimeStatus,
  desiredNCtx?: number,
): ManagedLocalRuntimeReadyOperation {
  const profileId = status.requested?.profileId
    ?? status.effective?.profileId
    ?? config.localRuntime?.profileId
    ?? LOCAL_RUNTIME_PROFILE_ID;
  const profile = getLocalRuntimeProfile(profileId);
  const reasoningEffort = status.requested?.reasoningEffort
    ?? status.effective?.reasoningEffort
    ?? config.localRuntime?.reasoningEffort
    ?? profile.defaultReasoningEffort;
  const candidate = validateLocalRuntimeCandidate({
    profileId,
    nCtx: desiredNCtx
      ?? status.requested?.nCtx
      ?? status.effective?.nCtx
      ?? config.localRuntime?.nCtx
      ?? profile.defaultContext,
    reasoningEffort,
  });

  if (status.pid === null) return { kind: "start", candidate };

  const current = status.requested ?? status.effective;
  if (
    !current
    || current.profileId !== candidate.profileId
    || current.nCtx !== candidate.nCtx
    || current.reasoningEffort !== candidate.reasoningEffort
  ) {
    return { kind: "apply", candidate, expectedRevision: status.revision };
  }
  // The child is already starting/running at the requested candidate. Calling
  // start is an idempotent poke: the supervisor rejects `already-running` or
  // `operation-in-progress`, and the readiness loop simply keeps waiting.
  return { kind: "start", candidate };
}

/**
 * Start the managed engine if needed and wait until it can serve, so a request naming the local
 * model blocks on the load rather than being told the model is "at capacity". See
 * `./on-demand.ts` for why first-request is the trigger and not picker selection.
 */
export async function ensureManagedLocalRuntimeReady(
  config: OcxConfig,
  /**
   * Context size the caller needs, from the picker's context tier. When the engine is up at a
   * different size it is re-applied (which restarts it) rather than served at the wrong window —
   * silently ignoring the request would make the picker control a lie.
   */
  desiredNCtx?: number,
): Promise<EnsureReadyResult> {
  if (desiredNCtx !== undefined && managedLocalRuntimeConsumerLeases.snapshot().modelHolds > 0) {
    const status = managedSupervisor.status(config);
    if ((status.effective ?? status.requested)?.nCtx !== desiredNCtx) {
      return { kind: "blocked", reason: "consumer-in-use" };
    }
  }
  // Readiness means "routable AND at the size that was asked for". Without the second half an
  // apply-triggered restart would return early: the outgoing engine still answers canRoute()
  // for a moment, so the wait would end before the new window existed.
  const isReady = (): boolean => {
    if (!managedSupervisor.canRoute()) return false;
    if (desiredNCtx === undefined) return true;
    return managedSupervisor.status(config).effective?.nCtx === desiredNCtx;
  };

  return ensureLocalRuntimeReady({
    canRoute: isReady,
    requestStart: () => {
      const status = managedSupervisor.status(config);
      const operation = selectManagedLocalRuntimeReadyOperation(
        config,
        status,
        desiredNCtx,
      );
      if (operation.kind === "apply") {
        managedSupervisor.requestApply(config, {
          ...operation.candidate,
          expectedRevision: operation.expectedRevision,
        });
        return;
      }
      managedSupervisor.requestStart(config, operation.candidate);
    },
    readStatus: () => managedSupervisor.status(config),
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });
}

/**
 * Release the engine when no managed-local request is active and the final settled request has
 * been idle for the configured window. Started by the server and left running for the process
 * lifetime; `unref` so it never holds the event loop open.
 */
let stopIdleSweep: (() => void) | null = null;

export function startManagedLocalRuntimeIdleSweep(config: OcxConfig): () => void {
  if (stopIdleSweep) return stopIdleSweep;
  const timer = setInterval(() => {
    const release = shouldReleaseIdleLocalRuntime({
      running: managedSupervisor.canRoute(),
      lastUsedAt: localRuntimeLastUsedAt(),
      now: Date.now(),
    });
    if (release) {
      const result = managedSupervisor.requestStop({ idle: true });
      if (result.accepted) {
        clearLocalRuntimeUse();
        managedLocalRuntimeConsumerLeases.clearModelUse();
      }
    }
  }, LOCAL_RUNTIME_IDLE_SWEEP_MS);
  timer.unref?.();
  stopIdleSweep = () => { clearInterval(timer); stopIdleSweep = null; };
  return stopIdleSweep;
}

/**
 * Is the Qwen managed-provider projection intact?
 *
 * A raw invalid profile id is never trusted here. Config loading migrates known
 * retired ids before this check; an unknown hand edit simply reports not-controlled.
 */
export function managedLocalRuntimeProviderIsValid(config: OcxConfig): boolean {
  const provider = config.providers[LOCAL_RUNTIME_PROVIDER_ID];
  return !!provider && isManagedLocalProviderProjection(LOCAL_RUNTIME_PROVIDER_ID, provider);
}

export async function shutdownManagedLocalRuntime(): Promise<void> {
  stopIdleSweep?.();
  await managedSupervisor.shutdown();
}
