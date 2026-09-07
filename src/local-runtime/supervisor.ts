import type { OcxConfig } from "../types";
import type { ConsumerLeaseRegistry } from "./consumer-leases";
import {
  LOCAL_RUNTIME_PROFILE_ID,
  type LocalRuntimeCandidate,
  type LocalRuntimeProfileId,
  getLocalRuntimeProfile,
  validateLocalRuntimeCandidate,
} from "./profile";

export type LocalRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "rolled-back"
  | "failed"
  | "blocked-foreign-port";

export type LocalRuntimeFailure =
  | "foreign-port"
  | "host-memory-low"
  | "candidate-readiness-failed"
  | "rollback-failed"
  | "start-failed"
  | "stop-failed";

export interface LocalRuntimeEffective extends LocalRuntimeCandidate {
  model: string;
  verifiedAt: string;
}

export interface LocalRuntimeHandle {
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(): Promise<void>;
}

export interface LocalRuntimeSupervisorDeps {
  now(): number;
  consumers?: ConsumerLeaseRegistry;
  activeUseCount?: () => number;
  /**
   * Takes the profile explicitly: each profile has its own model file and
   * expected size, so a parameterless check would silently verify the default
   * profile's model no matter which one is being launched.
   */
  assertProfileFiles(profileId: LocalRuntimeProfileId): void | Promise<void>;
  assertHostMemoryAvailable(
    profileId: LocalRuntimeProfileId,
  ): void | Promise<void>;
  isPortFree(): Promise<boolean>;
  launch(candidate: LocalRuntimeCandidate): Promise<LocalRuntimeHandle>;
  probe(
    handle: LocalRuntimeHandle,
    candidate: LocalRuntimeCandidate,
  ): Promise<LocalRuntimeEffective>;
  persistLastKnownGood(
    config: OcxConfig,
    candidate: LocalRuntimeCandidate,
    verifiedAt: string,
  ): void | Promise<void>;
}

export interface LocalRuntimeStatus {
  state: LocalRuntimeState;
  revision: number;
  requested: LocalRuntimeCandidate | null;
  effective: LocalRuntimeEffective | null;
  lastKnownGood: LocalRuntimeCandidate | null;
  failure: LocalRuntimeFailure | null;
  pid: number | null;
  operationPending: boolean;
}

export type LocalRuntimeMutationResult =
  | { accepted: true; revision: number }
  | {
    accepted: false;
    revision: number;
    reason:
      | "operation-in-progress"
      | "stale-revision"
      | "already-running"
      | "not-running"
      | "consumer-in-use"
      | "invalid-candidate";
  };

export interface LocalRuntimeControl {
  status(config: OcxConfig): LocalRuntimeStatus;
  requestStart(
    config: OcxConfig,
    candidate?: LocalRuntimeCandidate,
  ): LocalRuntimeMutationResult;
  requestApply(
    config: OcxConfig,
    /**
     * Unvalidated on purpose -- `validateLocalRuntimeCandidate` is the single
     * gate, so the strings are narrowed there rather than at every caller.
     * `reasoningEffort` must stay listed here: TypeScript compares method
     * parameters bivariantly, so an interface that omitted it would still be
     * satisfied by the implementation, and callers typed as
     * `LocalRuntimeControl` would silently drop the setting.
     */
    input: {
      profileId: string;
      nCtx: number;
      expectedRevision: number;
      reasoningEffort?: string;
    },
  ): LocalRuntimeMutationResult;
  requestStop(options?: { idle?: boolean }): LocalRuntimeMutationResult;
  whenIdle(): Promise<void>;
  canRoute(): boolean;
  shutdown(): Promise<void>;
}

function candidateFromConfig(config: OcxConfig): LocalRuntimeCandidate {
  const runtime = config.localRuntime;
  const profileId = runtime?.profileId ?? LOCAL_RUNTIME_PROFILE_ID;
  // An absent nCtx falls back to Qwen's declared default rather than a
  // hardcoded context value.
  const profile = getLocalRuntimeProfile(profileId);
  return validateLocalRuntimeCandidate({
    profileId,
    nCtx: runtime?.nCtx ?? profile.defaultContext,
    reasoningEffort: runtime?.reasoningEffort,
  });
}

function cloneCandidate(
  value: LocalRuntimeCandidate | null,
): LocalRuntimeCandidate | null {
  return value ? { ...value } : null;
}

function isHostMemoryLow(error: unknown): boolean {
  return error instanceof Error
    && error.message === "LOCAL_RUNTIME_HOST_MEMORY_LOW";
}

export class LocalRuntimeSupervisor implements LocalRuntimeControl {
  private state: LocalRuntimeState = "stopped";
  private revision = 0;
  private requested: LocalRuntimeCandidate | null = null;
  private effective: LocalRuntimeEffective | null = null;
  private lastKnownGood: LocalRuntimeCandidate | null = null;
  private failure: LocalRuntimeFailure | null = null;
  private handle: LocalRuntimeHandle | null = null;
  private generation = 0;
  private operation: Promise<void> | null = null;
  private shutdownRequested = false;

  constructor(private readonly deps: LocalRuntimeSupervisorDeps) {}

  status(config: OcxConfig): LocalRuntimeStatus {
    this.seedLastKnownGood(config);
    return {
      state: this.state,
      revision: this.revision,
      requested: cloneCandidate(this.requested),
      effective: this.effective ? { ...this.effective } : null,
      lastKnownGood: cloneCandidate(this.lastKnownGood),
      failure: this.failure,
      pid: this.handle?.pid ?? null,
      operationPending: this.operation !== null,
    };
  }

  requestStart(
    config: OcxConfig,
    input?: LocalRuntimeCandidate,
  ): LocalRuntimeMutationResult {
    if (this.operation) return this.rejected("operation-in-progress");
    // A retained handle remains owned even when readiness or a prior stop
    // failed. Never launch a second child until that exact handle exits.
    if (this.handle) return this.rejected("already-running");

    let candidate: LocalRuntimeCandidate;
    try {
      candidate = input
        ? validateLocalRuntimeCandidate(input)
        : candidateFromConfig(config);
    } catch {
      return this.rejected("invalid-candidate");
    }
    this.shutdownRequested = false;
    this.seedLastKnownGood(config);
    this.requested = candidate;
    this.state = "starting";
    this.failure = null;
    return this.accept(this.startOperation(config, candidate));
  }

  requestApply(
    config: OcxConfig,
    input: {
      profileId: string;
      nCtx: number;
      expectedRevision: number;
      reasoningEffort?: string;
    },
  ): LocalRuntimeMutationResult {
    if ((this.deps.consumers?.snapshot().modelHolds ?? 0) > 0) return this.rejected("consumer-in-use");
    if (this.operation) return this.rejected("operation-in-progress");
    if (input.expectedRevision !== this.revision) {
      return this.rejected("stale-revision");
    }
    this.shutdownRequested = false;
    let candidate: LocalRuntimeCandidate;
    try {
      candidate = validateLocalRuntimeCandidate(input);
    } catch {
      return this.rejected("invalid-candidate");
    }
    this.seedLastKnownGood(config);
    this.requested = candidate;
    this.state = this.handle ? "restarting" : "starting";
    this.failure = null;
    return this.accept(this.applyOperation(config, candidate));
  }

  requestStop(options: { idle?: boolean } = {}): LocalRuntimeMutationResult {
    const consumers = this.deps.consumers?.snapshot();
    if ((options.idle ? consumers?.modelHolds ?? 0 : consumers?.proxyHolds ?? 0) > 0
      || (this.deps.activeUseCount?.() ?? 0) > 0) return this.rejected("consumer-in-use");
    if (this.operation) return this.rejected("operation-in-progress");
    if (!this.handle) return this.rejected("not-running");
    this.state = "stopping";
    this.failure = null;
    return this.accept(this.stopOperation());
  }

  async whenIdle(): Promise<void> {
    await this.operation;
  }

  canRoute(): boolean {
    return this.operation === null
      && this.handle !== null
      && this.effective !== null
      && (this.state === "running" || this.state === "rolled-back");
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    await this.stopOwnedHandle().catch(() => {});
    await this.operation?.catch(() => {});
    try {
      await this.stopOwnedHandle();
    } catch (cause) {
      this.state = "failed";
      this.failure = "stop-failed";
      this.revision += 1;
      throw new Error("LOCAL_RUNTIME_STOP_FAILED", { cause });
    }
    this.effective = null;
    this.state = "stopped";
    this.failure = null;
    this.revision += 1;
  }

  private accept(operation: Promise<void>): LocalRuntimeMutationResult {
    this.revision += 1;
    this.operation = operation.finally(() => {
      this.operation = null;
      this.revision += 1;
    });
    return { accepted: true, revision: this.revision };
  }

  private rejected(
    reason: Extract<LocalRuntimeMutationResult, { accepted: false }>["reason"],
  ): LocalRuntimeMutationResult {
    return { accepted: false, reason, revision: this.revision };
  }

  private seedLastKnownGood(config: OcxConfig): void {
    if (this.lastKnownGood || !config.localRuntime?.verifiedAt) return;
    try {
      this.lastKnownGood = candidateFromConfig(config);
    } catch {
      // An invalid persisted candidate is never promoted or repaired here.
    }
  }

  private async startOperation(
    config: OcxConfig,
    candidate: LocalRuntimeCandidate,
  ): Promise<void> {
    try {
      const effective = await this.launchAndVerify(config, candidate);
      this.effective = effective;
      this.lastKnownGood = { ...candidate };
      this.state = "running";
    } catch (error) {
      this.effective = null;
      if (error instanceof Error && error.message === "LOCAL_RUNTIME_FOREIGN_PORT") {
        this.state = "blocked-foreign-port";
        this.failure = "foreign-port";
      } else if (isHostMemoryLow(error)) {
        this.state = "failed";
        this.failure = "host-memory-low";
      } else {
        this.state = "failed";
        this.failure = "start-failed";
      }
    }
  }

  private async applyOperation(
    config: OcxConfig,
    candidate: LocalRuntimeCandidate,
  ): Promise<void> {
    const rollback = this.lastKnownGood
      ? { ...this.lastKnownGood }
      : (this.effective ? {
        profileId: this.effective.profileId,
        nCtx: this.effective.nCtx,
        reasoningEffort: this.effective.reasoningEffort,
      } : null);
    try {
      await this.stopOwnedHandle();
    } catch {
      // The original child is still retained and may still be serving. Do not
      // launch either the candidate or rollback beside an unconfirmed process.
      this.state = "failed";
      this.failure = "stop-failed";
      return;
    }
    let candidateFailure: LocalRuntimeFailure;
    try {
      const effective = await this.launchAndVerify(config, candidate);
      this.effective = effective;
      this.lastKnownGood = { ...candidate };
      this.state = "running";
      return;
    } catch (error) {
      this.effective = null;
      candidateFailure = isHostMemoryLow(error)
        ? "host-memory-low"
        : "candidate-readiness-failed";
      this.failure = candidateFailure;
    }

    if (!rollback) {
      this.state = "failed";
      return;
    }
    try {
      const effective = await this.launchAndVerify(config, rollback);
      this.effective = effective;
      this.lastKnownGood = rollback;
      this.state = "rolled-back";
      this.failure = candidateFailure;
    } catch (error) {
      this.effective = null;
      this.state = "failed";
      this.failure = candidateFailure === "host-memory-low" || isHostMemoryLow(error)
        ? "host-memory-low"
        : "rollback-failed";
    }
  }

  private async stopOperation(): Promise<void> {
    try {
      await this.stopOwnedHandle();
      this.effective = null;
      this.state = "stopped";
    } catch {
      // Keep both the handle and last verified effective state visible so the
      // operator can retry the stop and diagnostics never claim it disappeared.
      this.state = "failed";
      this.failure = "stop-failed";
    }
  }

  private async launchAndVerify(
    config: OcxConfig,
    candidate: LocalRuntimeCandidate,
  ): Promise<LocalRuntimeEffective> {
    await this.deps.assertProfileFiles(candidate.profileId);
    if (this.shutdownRequested) throw new Error("LOCAL_RUNTIME_SHUTDOWN");
    await this.deps.assertHostMemoryAvailable(candidate.profileId);
    if (this.shutdownRequested) throw new Error("LOCAL_RUNTIME_SHUTDOWN");
    if (!(await this.deps.isPortFree())) {
      throw new Error("LOCAL_RUNTIME_FOREIGN_PORT");
    }
    const handle = await this.deps.launch(candidate);
    const generation = ++this.generation;
    this.handle = handle;
    this.observeExit(handle, generation);
    try {
      if (this.shutdownRequested) throw new Error("LOCAL_RUNTIME_SHUTDOWN");
      const effective = await this.deps.probe(handle, candidate);
      if (
        effective.profileId !== candidate.profileId
        || effective.nCtx !== candidate.nCtx
      ) {
        throw new Error("LOCAL_RUNTIME_READINESS_FAILED");
      }
      await this.deps.persistLastKnownGood(
        config,
        candidate,
        effective.verifiedAt,
      );
      if (this.handle !== handle || this.generation !== generation) {
        throw new Error("LOCAL_RUNTIME_OWNERSHIP_LOST");
      }
      if (this.shutdownRequested) throw new Error("LOCAL_RUNTIME_SHUTDOWN");
      return effective;
    } catch (error) {
      if (this.handle === handle) {
        await this.stopOwnedHandle();
      }
      throw error;
    }
  }

  private async stopOwnedHandle(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    const generation = this.generation;
    try {
      await handle.terminate();
    } catch (error) {
      // The exit observer may have won the race while terminate rejected. If
      // the exact handle is already gone, ownership is resolved; otherwise
      // retain it so a later stop/shutdown can retry.
      if (this.handle !== handle || this.generation !== generation) return;
      throw error;
    }
    if (this.handle === handle && this.generation === generation) {
      this.handle = null;
      this.generation += 1;
    }
  }

  private observeExit(handle: LocalRuntimeHandle, generation: number): void {
    void handle.exited.then(() => {
      if (this.handle !== handle || this.generation !== generation) return;
      this.handle = null;
      this.effective = null;
      if (this.state === "running" || this.state === "rolled-back") {
        this.state = "failed";
        this.failure = "start-failed";
        this.revision += 1;
      }
    }).catch(() => {
      if (this.handle !== handle || this.generation !== generation) return;
      this.handle = null;
      this.effective = null;
      this.state = "failed";
      this.failure = "start-failed";
      this.revision += 1;
    });
  }
}
