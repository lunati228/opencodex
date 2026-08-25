import { describe, expect, test } from "bun:test";
import {
  LocalRuntimeSupervisor,
  type LocalRuntimeHandle,
  type LocalRuntimeSupervisorDeps,
} from "../src/local-runtime/supervisor";
import {
  LOCAL_RUNTIME_PROFILE_ID,
  type LocalRuntimeCandidate,
} from "../src/local-runtime/profile";
import { QWEN_DEFAULT_CONTEXT } from "../src/local-runtime/context-tiers";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    localRuntime: {
      enabled: true,
      autoStart: true,
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: QWEN_DEFAULT_CONTEXT,
      verifiedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function harness(options: {
  portFree?: boolean;
  failContexts?: Set<number>;
  terminateFailures?: number;
} = {}) {
  const launches: LocalRuntimeCandidate[] = [];
  const stops: number[] = [];
  const persisted: LocalRuntimeCandidate[] = [];
  // Records which profile the file-identity gate was asked to verify.
  const verifiedProfiles: string[] = [];
  const releaseLaunch = deferred<void>();
  let holdFirstLaunch = false;
  let nextPid = 4000;
  let terminateFailures = options.terminateFailures ?? 0;
  const handles: LocalRuntimeHandle[] = [];
  const deps: LocalRuntimeSupervisorDeps = {
    now: () => 1_722_000_000_000,
    assertProfileFiles: profileId => { verifiedProfiles.push(profileId); },
    isPortFree: async () => options.portFree !== false,
    launch: async candidate => {
      launches.push(candidate);
      if (holdFirstLaunch) await releaseLaunch.promise;
      const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      const handle: LocalRuntimeHandle = {
        pid: nextPid++,
        exited: exit.promise,
        terminate: async () => {
          if (terminateFailures > 0) {
            terminateFailures -= 1;
            throw new Error("injected terminate failure");
          }
          stops.push(handle.pid);
          exit.resolve({ code: 0, signal: null });
        },
      };
      handles.push(handle);
      return handle;
    },
    probe: async (_handle, candidate) => {
      if (options.failContexts?.has(candidate.nCtx)) {
        throw new Error("LOCAL_RUNTIME_READINESS_FAILED");
      }
      return {
        profileId: candidate.profileId,
        nCtx: candidate.nCtx,
        model: "huihui-qwen3.8-27b-abliterated-q6-k-l",
        verifiedAt: "2026-07-27T00:00:00.000Z",
      };
    },
    persistLastKnownGood: (cfg, candidate, verifiedAt) => {
      persisted.push(candidate);
      cfg.localRuntime = {
        enabled: true,
        autoStart: cfg.localRuntime?.autoStart !== false,
        ...candidate,
        verifiedAt,
      };
    },
  };
  return {
    deps,
    launches,
    stops,
    persisted,
    verifiedProfiles,
    handles,
    releaseLaunch,
    setHoldFirstLaunch(value: boolean) { holdFirstLaunch = value; },
  };
}

describe("LocalRuntimeSupervisor", () => {
  test("owns one launched child and publishes effective state only after verification", async () => {
    const h = harness();
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();

    expect(supervisor.requestStart(cfg).accepted).toBe(true);
    await supervisor.whenIdle();

    expect(h.launches).toEqual([{
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: QWEN_DEFAULT_CONTEXT,
      reasoningEffort: "xhigh",
    }]);
    expect(supervisor.status(cfg)).toMatchObject({
      state: "running",
      effective: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
      lastKnownGood: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
      pid: 4000,
    });
    expect(h.persisted).toHaveLength(1);
  });

  test("passes the selected Qwen profile into its startup identity check", async () => {
    const h = harness();
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();

    supervisor.requestApply(cfg, {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131_072,
      expectedRevision: supervisor.status(cfg).revision,
    });
    await supervisor.whenIdle();

    expect(h.launches[0]?.profileId).toBe(LOCAL_RUNTIME_PROFILE_ID);
    expect(h.verifiedProfiles).toEqual([LOCAL_RUNTIME_PROFILE_ID]);
  });

  test("refuses a foreign listener without launching or killing anything", async () => {
    const h = harness({ portFree: false });
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();

    supervisor.requestStart(cfg);
    await supervisor.whenIdle();

    expect(h.launches).toHaveLength(0);
    expect(h.stops).toHaveLength(0);
    expect(supervisor.status(cfg)).toMatchObject({
      state: "blocked-foreign-port",
      failure: "foreign-port",
    });
  });

  test("rejects concurrent and stale mutations", async () => {
    const h = harness();
    h.setHoldFirstLaunch(true);
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();

    const first = supervisor.requestStart(cfg);
    const second = supervisor.requestStart(cfg);
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, reason: "operation-in-progress" });

    h.releaseLaunch.resolve();
    await supervisor.whenIdle();
    const stale = supervisor.requestApply(cfg, {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131072,
      expectedRevision: 0,
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale-revision" });
  });

  test("rolls a failed context change back to the prior verified profile", async () => {
    const h = harness({ failContexts: new Set([QWEN_DEFAULT_CONTEXT]) });
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();
    cfg.localRuntime!.nCtx = 131072;
    supervisor.requestStart(cfg);
    await supervisor.whenIdle();

    const revision = supervisor.status(cfg).revision;
    expect(supervisor.requestApply(cfg, {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: QWEN_DEFAULT_CONTEXT,
      expectedRevision: revision,
    }).accepted).toBe(true);
    await supervisor.whenIdle();

    expect(h.launches.map(candidate => candidate.nCtx)).toEqual([
      131072,
      QWEN_DEFAULT_CONTEXT,
      131072,
    ]);
    expect(supervisor.status(cfg)).toMatchObject({
      state: "rolled-back",
      requested: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
      effective: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: 131072 },
      lastKnownGood: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: 131072 },
      failure: "candidate-readiness-failed",
    });
    expect(cfg.localRuntime?.nCtx).toBe(131072);
  });

  test("retains ownership and effective state after a failed stop so it can be retried", async () => {
    const h = harness({ terminateFailures: 1 });
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();
    supervisor.requestStart(cfg);
    await supervisor.whenIdle();

    expect(supervisor.requestStop().accepted).toBe(true);
    await supervisor.whenIdle();
    expect(supervisor.status(cfg)).toMatchObject({
      state: "failed",
      failure: "stop-failed",
      effective: { nCtx: QWEN_DEFAULT_CONTEXT },
      pid: 4000,
    });
    expect(supervisor.canRoute()).toBe(false);

    expect(supervisor.requestStop().accepted).toBe(true);
    await supervisor.whenIdle();
    expect(supervisor.status(cfg)).toMatchObject({
      state: "stopped",
      effective: null,
      pid: null,
    });
    expect(h.stops).toEqual([4000]);
  });

  test("does not launch a candidate or rollback beside a child whose stop failed", async () => {
    const h = harness({ terminateFailures: 1 });
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();
    supervisor.requestStart(cfg);
    await supervisor.whenIdle();

    const revision = supervisor.status(cfg).revision;
    expect(supervisor.requestApply(cfg, {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131072,
      expectedRevision: revision,
    }).accepted).toBe(true);
    await supervisor.whenIdle();

    expect(h.launches.map(candidate => candidate.nCtx)).toEqual([QWEN_DEFAULT_CONTEXT]);
    expect(supervisor.status(cfg)).toMatchObject({
      state: "failed",
      failure: "stop-failed",
      effective: { nCtx: QWEN_DEFAULT_CONTEXT },
      pid: 4000,
    });
  });

  test("shutdown never reports stopped while an owned handle cannot be terminated", async () => {
    const h = harness({ terminateFailures: 2 });
    const supervisor = new LocalRuntimeSupervisor(h.deps);
    const cfg = config();
    supervisor.requestStart(cfg);
    await supervisor.whenIdle();

    await expect(supervisor.shutdown()).rejects.toThrow("LOCAL_RUNTIME_STOP_FAILED");
    expect(supervisor.status(cfg)).toMatchObject({
      state: "failed",
      failure: "stop-failed",
      effective: { nCtx: QWEN_DEFAULT_CONTEXT },
      pid: 4000,
    });

    await supervisor.shutdown();
    expect(supervisor.status(cfg)).toMatchObject({
      state: "stopped",
      effective: null,
      pid: null,
    });
  });
});
