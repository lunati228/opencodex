/**
 * Codex companion — ties the proxy's lifetime to Codex's own.
 *
 * Why this exists alongside the two mechanisms that were already here:
 *
 * - `ocx service` keeps the proxy up from login until logout. Always available,
 *   but always resident too.
 * - `ocx codex-shim` starts the proxy on demand, but it works by wrapping the
 *   *script* launchers (`codex.cmd` / `codex.ps1`). The Codex desktop app is an
 *   executable and never goes through them, so the shim never fires for it. It
 *   also has no matching stop: nothing ever brings the proxy back down.
 *
 * Neither gives "starts when Codex starts, stops when Codex stops" for the
 * desktop app, which is what this does.
 *
 * Two deliberate safety properties:
 *
 * 1. **It only stops a proxy it started itself.** A proxy started by `ocx start`,
 *    by `ocx service`, or by a second companion is left completely alone. Without
 *    this, closing Codex would silently kill a proxy an operator was using for
 *    something else.
 * 2. **It lingers before stopping.** The desktop app briefly has zero live
 *    processes while it restarts itself (updates, reloads), and bouncing the
 *    proxy through that window would drop in-flight requests for no reason.
 *
 * The decision is a pure function so both properties are testable without
 * spawning a process or waiting on a clock.
 */

/** How long Codex must stay absent before a companion-started proxy is stopped. */
export const COMPANION_LINGER_MS = 20_000;
/** Gap between observations. Cheap enough to poll; slow enough to be invisible. */
export const COMPANION_POLL_MS = 3_000;

/**
 * Image names counted as "Codex is running".
 *
 * Matched on the image name rather than the full path because enumerating
 * executable paths for another user's processes needs privileges this runs
 * without. `ocx codex-companion status` prints what is actually matching, so a
 * renamed or additional desktop binary can be confirmed rather than assumed.
 */
export const DEFAULT_CODEX_IMAGE_NAMES: readonly string[] = ["codex.exe"] as const;

export type CompanionAction =
  | "start-proxy"
  | "restart-proxy"
  | "release-model"
  | "stop-proxy"
  | "wait";

export interface CompanionState {
  /** When Codex was last observed running; null when it has not been seen yet. */
  codexLastSeenAt: number | null;
  /** True only while a proxy this companion started is still believed to be up. */
  startedByCompanion: boolean;
  /**
   * True once the model has been released for the current Codex-absent period.
   * Without it the release would re-fire on every poll, since the proxy (which
   * gates the branch) deliberately stays up. Cleared when Codex reappears.
   */
  modelReleased: boolean;
  /**
   * PIDs in the Codex process generation that opened the current session.
   * Preserve them through a short zero-process probe so a real replacement is
   * distinguishable from the same process returning after one missed poll.
   */
  codexProcessIds?: readonly number[];
}

export function initialCompanionState(): CompanionState {
  return {
    codexLastSeenAt: null,
    startedByCompanion: false,
    modelReleased: false,
    codexProcessIds: [],
  };
}

export interface CompanionObservation {
  codexRunning: boolean;
  /** Stable process identities when the platform probe can provide them. */
  codexProcessIds?: readonly number[];
  proxyRunning: boolean;
  /** Durable provenance recovered from identity-checked protected runtime metadata. */
  proxyOwnedByCompanion?: boolean;
  now: number;
  lingerMs?: number;
  /**
   * Release the local model when Codex closes. **On by default.**
   *
   * This stops llama-server (~26 GB plus KV cache across both GPUs for Qwen) and deliberately
   * leaves the proxy running.
   *
   * Stopping the *proxy* here would be wrong. `ocx stop` also restores native
   * Codex, removing the injected `openai_base_url` from `~/.codex/config.toml`.
   * That is right on its own, but the companion cannot observe Codex until its
   * process already exists, so every launch would run:
   *
   *   Codex starts → reads an un-injected config → companion notices → re-injects
   *
   * landing too late for the session that just started, and silently bypassing
   * the proxy on *each* launch. The proxy is a few MB of loopback listener; the
   * model is the only thing whose cost is worth reclaiming.
   *
   * `stopProxyOnClose` handles the proxy separately, and safely — see below.
   */
  releaseModelOnClose?: boolean;
  /**
   * Stop the proxy PROCESS once the model has been released. **On by default.**
   *
   * This is what makes "close Codex and everything opencodex started goes away"
   * true rather than nearly true. It is safe in a way `ocx stop` is not, because
   * it stops only the process and deliberately leaves `~/.codex/config.toml`
   * injected. The failure mode described above — Codex reading an un-injected
   * config on the next launch and silently bypassing the proxy — cannot happen
   * when the injection is never removed.
   *
   * The remaining exposure is a few seconds at the start of the next session:
   * the injection points at a port nothing is listening on until the companion
   * observes `codex.exe` and starts the proxy again (one poll, ~3 s). Codex
   * spawns `codex.exe` ~4 s after the app appears and does not issue a model
   * request until the user sends one, so in practice the proxy is back well
   * before the first request. A request that does land in that window fails with
   * a connection error and succeeds on retry — visibly, not silently, which is
   * the important difference.
   *
   * Ownership still gates this: a proxy this companion did not start is left
   * alone, exactly as before.
   */
  stopProxyOnClose?: boolean;
}

function normalizedProcessIds(processIds: readonly number[] | undefined): number[] {
  if (!processIds) return [];
  return [...new Set(processIds.filter(
    pid => Number.isSafeInteger(pid) && pid > 0,
  ))].sort((left, right) => left - right);
}

function processSetsOverlap(left: readonly number[], right: readonly number[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some(pid => rightSet.has(pid));
}

/**
 * Decide the next action and the state that follows it.
 *
 * Pure: same inputs, same outputs, no clock and no I/O. `state` is not mutated.
 */
export function decideCompanionAction(
  observation: CompanionObservation,
  state: CompanionState,
): { action: CompanionAction; state: CompanionState } {
  const { codexRunning, proxyRunning, now } = observation;
  const lingerMs = observation.lingerMs ?? COMPANION_LINGER_MS;

  // A missed proxy observation clears only the in-memory claim. A later
  // identity-checked runtime record can restore companion ownership for the same
  // launch; an unmarked manual/service replacement is still never adopted.
  const owned = proxyRunning && (
    observation.proxyOwnedByCompanion !== undefined
      ? observation.proxyOwnedByCompanion
      : state.startedByCompanion
  );
  const codexLastSeenAt = codexRunning ? now : state.codexLastSeenAt;
  // A live Codex re-arms the release for the next time it goes away.
  const modelReleased = codexRunning ? false : state.modelReleased;
  const previousProcessIds = normalizedProcessIds(state.codexProcessIds);
  const observedProcessIds = normalizedProcessIds(observation.codexProcessIds);
  const processIdentityAvailable = observation.codexProcessIds !== undefined;
  const codexGenerationReplaced = processIdentityAvailable
    && codexRunning
    && previousProcessIds.length > 0
    && observedProcessIds.length > 0
    && !processSetsOverlap(previousProcessIds, observedProcessIds);
  let codexProcessIds = previousProcessIds;
  if (
    processIdentityAvailable
    && codexRunning
    && (
      previousProcessIds.length === 0
      || processSetsOverlap(previousProcessIds, observedProcessIds)
    )
  ) {
    // Advance a continuous process generation. This covers multi-process app
    // handoffs such as [old] -> [old,new] -> [new] without later mistaking the
    // settled [new] set for a close/reopen that happened between polls.
    codexProcessIds = observedProcessIds;
  } else if (codexGenerationReplaced && !owned) {
    // A foreign proxy is never recycled. Adopt the new Codex generation only
    // to avoid reconsidering the same forbidden action on every poll.
    codexProcessIds = observedProcessIds;
  }

  if (codexRunning && !proxyRunning) {
    return {
      action: "start-proxy",
      state: {
        codexLastSeenAt,
        startedByCompanion: true,
        modelReleased: false,
        codexProcessIds: processIdentityAvailable ? observedProcessIds : codexProcessIds,
      },
    };
  }

  // The linger tolerates momentary zero-process gaps, but a close/reopen can
  // complete between polls. A fully disjoint PID generation is durable evidence
  // of replacement. Recycle only a companion-owned proxy; manual/service
  // proxies remain untouched.
  if (codexGenerationReplaced && owned) {
    return {
      action: "restart-proxy",
      state: {
        codexLastSeenAt,
        startedByCompanion: true,
        modelReleased: false,
        codexProcessIds: observedProcessIds,
      },
    };
  }

  // Releasing the MODEL is deliberately not gated on `owned`, unlike stopping the proxy.
  // Ownership is about not killing someone else's process; the model is a ~22 GB shared
  // resource whose only justification for being resident is a client using it. Requiring
  // ownership meant a proxy started any other way (by hand, by `ocx service`) kept the model
  // pinned forever after Codex closed — the exact symptom that prompted this change.
  //
  // `codexLastSeenAt === null` still blocks it: never having seen Codex means this model was
  // loaded for something else, and yanking it at companion startup would be a surprise. The
  // server-side idle sweep reclaims that case instead.
  if (
    !codexRunning && proxyRunning && !modelReleased
    && codexLastSeenAt !== null
    && observation.releaseModelOnClose !== false
    && now - codexLastSeenAt >= lingerMs
  ) {
    // The proxy claim is preserved as-is: whether we own it is what decides if we may stop
    // it on the next tick.
    return {
      action: "release-model",
      state: {
        codexLastSeenAt,
        startedByCompanion: owned,
        modelReleased: true,
        codexProcessIds,
      },
    };
  }

  // Model already released and Codex still gone: take the proxy down too, so nothing
  // opencodex started outlives the app. Deliberately a SEPARATE tick from the release —
  // releasing the model goes through the proxy's management API, so stopping the proxy in
  // the same pass would race that call. `modelReleased` is what sequences the two.
  //
  // `owned` is required here and not for the model: this stops another process, and a proxy
  // started by `ocx start` or `ocx service` belongs to whoever started it.
  if (
    !codexRunning && proxyRunning && modelReleased
    && codexLastSeenAt !== null
    && owned
    && observation.stopProxyOnClose !== false
    && now - codexLastSeenAt >= lingerMs
  ) {
    // The claim is dropped with the process. If a proxy reappears later it is someone
    // else's until this companion starts one itself.
    return {
      action: "stop-proxy",
      state: {
        codexLastSeenAt,
        startedByCompanion: false,
        modelReleased,
        codexProcessIds,
      },
    };
  }

  return {
    action: "wait",
    state: {
      codexLastSeenAt,
      startedByCompanion: owned,
      modelReleased,
      codexProcessIds,
    },
  };
}

export interface CompanionDeps {
  codexIsRunning(): Promise<boolean>;
  /** One bounded process snapshot; when present it is authoritative for liveness too. */
  codexProcessIds?(): Promise<readonly number[]>;
  proxyIsRunning(): Promise<boolean>;
  /** Ownership captured by the same liveness observation; defaults to in-memory state only. */
  proxyOwnedByCompanion?(): boolean | undefined;
  startProxy(): Promise<void>;
  /** Gracefully recycle the exact companion-owned proxy without stripping routing. */
  restartProxy?(): Promise<void | "busy">;
  /** Stop llama-server only. Must NOT stop the proxy — see releaseModelOnClose. */
  releaseModel(): Promise<void>;
  /**
   * Stop the proxy PROCESS only. Must NOT restore native Codex: the injected
   * `openai_base_url` has to survive, or the next launch bypasses the proxy.
   */
  stopProxy(): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** Loop control: return false to stop. Defaults to running forever. */
  shouldContinue?(): boolean;
  /** See `CompanionObservation.releaseModelOnClose`. On unless explicitly disabled. */
  releaseModelOnClose?: boolean;
  /** See `CompanionObservation.stopProxyOnClose`. On unless explicitly disabled. */
  stopProxyOnClose?: boolean;
}

/**
 * Poll, decide, act. Errors from start/stop are logged and the loop continues —
 * a transient failure to reach the proxy must not kill the companion, because
 * nothing would restart it until the next login.
 */
export async function runCodexCompanion(deps: CompanionDeps): Promise<void> {
  let state = initialCompanionState();
  const shouldContinue = deps.shouldContinue ?? (() => true);

  while (shouldContinue()) {
    let codexObservation: { codexRunning: boolean; codexProcessIds?: readonly number[] };
    let proxyRunning: boolean;
    try {
      [codexObservation, proxyRunning] = await Promise.all([
        deps.codexProcessIds
          ? deps.codexProcessIds().then(codexProcessIds => ({
            codexRunning: codexProcessIds.length > 0,
            codexProcessIds,
          }))
          : deps.codexIsRunning().then(codexRunning => ({ codexRunning })),
        deps.proxyIsRunning(),
      ]);
    } catch (error) {
      // Uncertain process visibility is never evidence that Codex closed. Keep
      // all lifecycle state intact and retry on the next bounded poll.
      deps.log(
        `companion observation failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      await deps.sleep(COMPANION_POLL_MS);
      continue;
    }
    const previousState = state;
    const decided = decideCompanionAction(
      {
        ...codexObservation,
        proxyRunning,
        ...(deps.proxyOwnedByCompanion
          ? { proxyOwnedByCompanion: deps.proxyOwnedByCompanion() }
          : {}),
        now: deps.now(),
        ...(deps.releaseModelOnClose === false ? { releaseModelOnClose: false } : {}),
        ...(deps.stopProxyOnClose === false ? { stopProxyOnClose: false } : {}),
      },
      state,
    );
    state = decided.state;

    try {
      if (decided.action === "start-proxy") {
        deps.log("Codex is running and the proxy is not — starting it.");
        await deps.startProxy();
      } else if (decided.action === "restart-proxy") {
        deps.log("Codex process generation changed - gracefully recycling its proxy.");
        if (!deps.restartProxy) throw new Error("graceful proxy restart is unavailable");
        const restart = await deps.restartProxy();
        if (restart === "busy") {
          // The server refused before draining because a data-plane turn was
          // active. Restore only the former generation so the next poll retries
          // the harmless idle-gated request; every other outcome stays latched.
          state = { ...state, codexProcessIds: previousState.codexProcessIds };
          deps.log("Proxy still has active turns - deferring the Codex-generation recycle.");
        }
      } else if (decided.action === "release-model") {
        deps.log("Codex has closed — releasing the local model.");
        await deps.releaseModel();
      } else if (decided.action === "stop-proxy") {
        deps.log("Model released — stopping the proxy (Codex routing stays injected).");
        await deps.stopProxy();
      }
    } catch (error) {
      // Re-arm on a failed release so the next tick retries, rather than leaving
      // ~28 GB and both GPUs held because one management call happened to fail.
      if (decided.action === "release-model") state = { ...state, modelReleased: false };
      // The replacement request may have reached the proxy even when its result
      // is uncertain. Keep the new Codex generation latched so this loop never
      // replays the same restart transaction automatically.
      // A failed stop must keep the claim, or the proxy we started becomes unstoppable:
      // `owned` gates the branch, and dropping it would strand the process until logout.
      if (decided.action === "stop-proxy") state = { ...state, startedByCompanion: true };
      deps.log(
        `companion action ${decided.action} failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await deps.sleep(COMPANION_POLL_MS);
  }
}
