import type {
  LocalRuntimeFailure,
  LocalRuntimeStatus,
} from "./supervisor";

/**
 * On-demand lifecycle for the managed local model.
 *
 * ## Why this exists
 *
 * The local model costs ~22 GB resident, so it must not be loaded speculatively — but it also
 * must not require a visit to the dashboard before the first message. Two earlier mechanisms both
 * failed this:
 *
 * - Routing threw `LocalRuntimeUnavailableError` when the engine was down, which Codex surfaced as
 *   "Selected model is at capacity. Please try a different model." That is actively misleading:
 *   nothing is at capacity, the engine simply is not running, and the user is told to give up
 *   rather than to wait.
 * - `localRuntime.autoStart` loads at *proxy boot*, which is only coincidentally when Codex opens.
 *   Start the proxy any other way and 22 GB is pinned with no client attached.
 *
 * So: load when a request actually needs the model, and release when nothing has needed it for a
 * while. A picker selection cannot be the trigger — Codex never tells the proxy which model is
 * selected, only which model a request is for (the websocket carries auth and turn state, no model
 * id). "First message" is therefore the earliest observable intent, and an idle timer is the
 * honest inverse of it.
 *
 * ## Why the idle window is minutes, not seconds
 *
 * The obvious rule — release as soon as the user switches models — is unobservable for the same
 * reason. An idle timer approximates it, but a short one punishes ordinary thinking pauses between
 * messages by unloading and reloading the model. Five minutes is long enough that a normal pause
 * never triggers it, and short enough that walking away frees the memory.
 */

/** No settled request needs the local model for this long releases it. */
export const LOCAL_RUNTIME_IDLE_RELEASE_MS = 5 * 60_000;

/** How often the idle sweep runs. Fine relative to the window; the check itself is free. */
export const LOCAL_RUNTIME_IDLE_SWEEP_MS = 30_000;

/**
 * Longest a request will wait for a cold load before returning a retryable error.
 *
 * A warm load measured ~17 s on this host (page cache still holding the GGUF); a genuinely cold
 * one is slower and unmeasured, so this is deliberately generous. It is a backstop against
 * hanging forever, not a prediction of load time.
 */
export const LOCAL_RUNTIME_LOAD_WAIT_MS = 180_000;

/** Poll interval while waiting for the engine to become routable. */
export const LOCAL_RUNTIME_READY_POLL_MS = 500;

// Module-level because local-runtime demand is process-wide, not per request. The idle sweep must
// see both the last settled use and every queued/streaming request that still owns the runtime.
let lastUsedAt: number | null = null;
let activeManagedLocalRuntimeUses = 0;

/** Record when the final active managed-local request has settled. */
export function noteLocalRuntimeUse(now: number = Date.now()): void {
  lastUsedAt = now;
}

export function localRuntimeLastUsedAt(): number | null {
  return lastUsedAt;
}

/** Number of queued, running, or unwinding managed-local requests. */
export function localRuntimeActiveUseCount(): number {
  return activeManagedLocalRuntimeUses;
}

export interface ManagedLocalRuntimeUseLease {
  /** Idempotently settle this request and stamp idle time after the final active request ends. */
  release(now?: number): void;
}

/**
 * Keep the managed local runtime resident for one request from admission through every terminal
 * path. A queued request owns a lease too: otherwise the idle sweep can kill the one model that is
 * about to receive it.
 */
export function acquireManagedLocalRuntimeUse(): ManagedLocalRuntimeUseLease {
  activeManagedLocalRuntimeUses += 1;
  let released = false;
  return {
    release(now: number = Date.now()): void {
      if (released) return;
      released = true;
      activeManagedLocalRuntimeUses -= 1;
      if (activeManagedLocalRuntimeUses === 0) noteLocalRuntimeUse(now);
    },
  };
}

/**
 * Attach a managed-local lease to the existing stream terminal hook. `trackStreamLifetime` invokes
 * that hook for completion, cancellation, and read errors; `finally` keeps the lease safe if the
 * caller's cleanup throws.
 */
export function localRuntimeUseOnDone(
  lease: ManagedLocalRuntimeUseLease,
  onDone?: () => void,
): () => void {
  return () => {
    try {
      onDone?.();
    } finally {
      lease.release();
    }
  };
}

/**
 * Forget the last use. Called after an idle release so the engine is not immediately eligible
 * again on the next sweep, and by tests to isolate cases.
 */
export function clearLocalRuntimeUse(): void {
  lastUsedAt = null;
}

export interface IdleReleaseObservation {
  /** Engine currently loaded? Releasing something already down is a no-op we skip. */
  running: boolean;
  /** `null` means "never used this process" — see the note in the implementation. */
  lastUsedAt: number | null;
  now: number;
  idleMs?: number;
}

/**
 * Should the idle sweep release the model now?
 *
 * A `null` `lastUsedAt` with the engine running means it was started by something other than a
 * request — the dashboard's Start button, or a leftover `autoStart`. Releasing that immediately
 * would fight an operator who deliberately pressed Start, so it is left alone; the Codex-close
 * path in the companion is what reclaims it.
 */
export function shouldReleaseIdleLocalRuntime(observation: IdleReleaseObservation): boolean {
  const { running, lastUsedAt: usedAt, now, idleMs = LOCAL_RUNTIME_IDLE_RELEASE_MS } = observation;
  if (!running || usedAt === null || activeManagedLocalRuntimeUses > 0) return false;
  return now - usedAt >= idleMs;
}

export interface EnsureReadyDeps {
  /** Is the engine routable right now? */
  canRoute: () => boolean;
  /** Ask the supervisor to start. Idempotent — a start already in flight must not be duplicated. */
  requestStart: () => void;
  /**
   * Observe supervisor state without waiting for the outer timeout. A terminal startup failure is
   * different from a slow load and must be returned as soon as the supervisor publishes it.
   */
  readStatus?: () => Pick<LocalRuntimeStatus, "state" | "failure">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

export type EnsureReadyResult =
  | "already-ready"
  | "started"
  | "timeout"
  | { kind: "failed"; failure: LocalRuntimeFailure };

const LOCAL_RUNTIME_FAILURE_MESSAGES = {
  "foreign-port": "Local model could not start because its loopback port is already in use.",
  "host-memory-low": "Local model could not start because available system memory fell below its configured safety reserve.",
  "candidate-readiness-failed": "Local model failed its readiness check.",
  "rollback-failed": "Local model failed its readiness check and rollback also failed.",
  "stop-failed": "Local model could not start because the previous runtime could not be stopped.",
  "start-failed": "Local model failed to start.",
} satisfies Record<LocalRuntimeFailure, string>;

function observedTerminalFailure(
  status: Pick<LocalRuntimeStatus, "state" | "failure"> | undefined,
): LocalRuntimeFailure | null {
  if (
    !status
    || (status.state !== "failed" && status.state !== "blocked-foreign-port")
  ) {
    return null;
  }
  return status.failure;
}

/** Safe user-facing explanation for a non-successful readiness result. */
export function localRuntimeReadinessErrorMessage(
  result: EnsureReadyResult,
): string | undefined {
  if (result === "already-ready" || result === "started") return undefined;
  if (result === "timeout") {
    return "Local model is still loading. Send the message again in a moment.";
  }
  return LOCAL_RUNTIME_FAILURE_MESSAGES[result.failure];
}

/**
 * Bring the local engine up and wait until it can serve, so a request that names the local model
 * blocks on the load instead of being rejected.
 *
 * Returns `"timeout"` for a genuinely slow load and a structured failure once the supervisor has
 * reached a terminal state. The caller turns either result into a safe 503 rather than leaving the
 * request looking active after startup has already stopped.
 */
export async function ensureLocalRuntimeReady(deps: EnsureReadyDeps): Promise<EnsureReadyResult> {
  if (deps.canRoute()) return "already-ready";

  const timeoutMs = deps.timeoutMs ?? LOCAL_RUNTIME_LOAD_WAIT_MS;
  const pollMs = deps.pollMs ?? LOCAL_RUNTIME_READY_POLL_MS;
  const deadline = deps.now() + timeoutMs;

  // Safe to call unconditionally: the supervisor collapses a start request while one is already
  // in flight, so two concurrent first-requests produce one load, not two.
  deps.requestStart();

  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    if (deps.canRoute()) return "started";
    const failure = observedTerminalFailure(deps.readStatus?.());
    if (failure) return { kind: "failed", failure };
  }
  if (deps.canRoute()) return "started";
  const failure = observedTerminalFailure(deps.readStatus?.());
  return failure ? { kind: "failed", failure } : "timeout";
}
