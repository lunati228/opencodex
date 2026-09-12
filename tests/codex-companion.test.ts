import { afterEach, describe, expect, test } from "bun:test";
import {
  COMPANION_LINGER_MS,
  decideCompanionAction,
  initialCompanionState,
  runCodexCompanion,
  type CompanionState,
} from "../src/codex/companion";
import {
  restartCompanionProxy,
  runningCodexProcesses,
  runningCodexImages,
  setCompanionProcessQueryRunnerForTests,
} from "../src/codex/companion-runtime";

afterEach(() => setCompanionProcessQueryRunnerForTests(null));

const OWNED: CompanionState = {
  codexLastSeenAt: 1_000,
  startedByCompanion: true,
  modelReleased: false,
};
const FOREIGN: CompanionState = {
  codexLastSeenAt: 1_000,
  startedByCompanion: false,
  modelReleased: false,
};

describe("decideCompanionAction", () => {
  test("starts the proxy when Codex is up and the proxy is not", () => {
    const decided = decideCompanionAction(
      { codexRunning: true, proxyRunning: false, now: 1_000 },
      initialCompanionState(),
    );
    expect(decided.action).toBe("start-proxy");
    expect(decided.state.startedByCompanion).toBe(true);
  });

  test("does nothing while both are up", () => {
    const decided = decideCompanionAction(
      { codexRunning: true, proxyRunning: true, now: 2_000 },
      OWNED,
    );
    expect(decided.action).toBe("wait");
    expect(decided.state.codexLastSeenAt).toBe(2_000);
  });

  test("waits out the linger window before releasing the model", () => {
    const justClosed = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS - 1 },
      OWNED,
    );
    expect(justClosed.action).toBe("wait");
    expect(justClosed.state.startedByCompanion).toBe(true);
  });

  test("releases the model once Codex has stayed away for the linger window", () => {
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS },
      OWNED,
    );
    expect(decided.action).toBe("release-model");
    // The proxy claim is KEPT — only the model is released.
    expect(decided.state.startedByCompanion).toBe(true);
    expect(decided.state.modelReleased).toBe(true);
  });

  test("releases only ONCE per Codex-absent period", () => {
    // Without the modelReleased latch the release would re-fire on every 3 s poll while
    // the proxy is still up. The tick AFTER the release is now the proxy stop, so pin the
    // sequence release -> stop -> (nothing left to do) rather than release -> wait.
    const first = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS },
      OWNED,
    );
    expect(first.action).toBe("release-model");
    const second = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 2_000_000 },
      first.state,
    );
    expect(second.action).toBe("stop-proxy");
    // Once the proxy is gone there is nothing left to act on, and the release must not
    // re-fire: `modelReleased` stays latched for the rest of this Codex-absent period.
    const third = decideCompanionAction(
      { codexRunning: false, proxyRunning: false, now: 3_000_000 },
      second.state,
    );
    expect(third.action).toBe("wait");
  });

  test("keeping the model loaded also keeps the proxy up", () => {
    // `--keep-model-loaded` must not become a way to kill the proxy while the model it
    // was protecting stays resident: the stop is sequenced behind the release.
    const decided = decideCompanionAction(
      {
        codexRunning: false,
        proxyRunning: true,
        now: 1_000 + COMPANION_LINGER_MS,
        releaseModelOnClose: false,
      },
      OWNED,
    );
    expect(decided.action).toBe("wait");
  });

  test("stopProxyOnClose:false stops at the model release", () => {
    const first = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS, stopProxyOnClose: false },
      OWNED,
    );
    expect(first.action).toBe("release-model");
    const second = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 2_000_000, stopProxyOnClose: false },
      first.state,
    );
    expect(second.action).toBe("wait");
  });

  test("never stops a proxy this companion did not start", () => {
    // Ownership gates the proxy stop but NOT the model release: killing another
    // operator's proxy is the failure this protects against.
    const foreign = { codexLastSeenAt: 1_000, startedByCompanion: false, modelReleased: true };
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS },
      foreign,
    );
    expect(decided.action).toBe("wait");
  });

  test("re-arms the release after Codex comes back and closes again", () => {
    const released = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 1_000 + COMPANION_LINGER_MS },
      OWNED,
    ).state;
    const reopened = decideCompanionAction(
      { codexRunning: true, proxyRunning: true, now: 3_000_000 },
      released,
    );
    expect(reopened.state.modelReleased).toBe(false);
    const closedAgain = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 3_000_000 + COMPANION_LINGER_MS },
      reopened.state,
    );
    expect(closedAgain.action).toBe("release-model");
  });

  test("--keep-model-loaded suppresses the release entirely", () => {
    const decided = decideCompanionAction(
      {
        codexRunning: false,
        proxyRunning: true,
        now: 10_000_000,
        releaseModelOnClose: false,
      },
      OWNED,
    );
    expect(decided.action).toBe("wait");
  });

  test("a Codex restart inside the linger window does not bounce the proxy", () => {
    let state = OWNED;
    for (const [now, codexRunning] of [
      [5_000, false],
      [8_000, false],
      [11_000, true], // came back before the window elapsed
      [40_000, true],
    ] as const) {
      const decided = decideCompanionAction({ codexRunning, proxyRunning: true, now }, state);
      expect(decided.action).toBe("wait");
      state = decided.state;
    }
  });

  test("recycles an owned proxy when Codex is replaced inside the linger window", () => {
    const first = decideCompanionAction(
      {
        codexRunning: true,
        codexProcessIds: [101],
        proxyRunning: true,
        proxyOwnedByCompanion: true,
        now: 1_000,
      },
      initialCompanionState(),
    );
    expect(first.action).toBe("wait");

    const replacement = decideCompanionAction(
      {
        codexRunning: true,
        codexProcessIds: [202],
        proxyRunning: true,
        proxyOwnedByCompanion: true,
        now: 2_000,
      },
      first.state,
    );
    expect(replacement.action).toBe("restart-proxy");
  });

  test("does not recycle when the same Codex PID returns after one missed probe", () => {
    const first = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [101], proxyRunning: true, now: 1_000 },
      OWNED,
    );
    const missed = decideCompanionAction(
      { codexRunning: false, codexProcessIds: [], proxyRunning: true, now: 2_000 },
      first.state,
    );
    const returned = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [101], proxyRunning: true, now: 3_000 },
      missed.state,
    );

    expect(missed.action).toBe("wait");
    expect(returned.action).toBe("wait");
  });

  test("keep-proxy-running adopts a new Codex generation without recycling", () => {
    let state: CompanionState = { ...OWNED, codexProcessIds: [101] };
    for (const processIds of [[202], [202], [303]]) {
      const decided = decideCompanionAction({
        codexRunning: true,
        codexProcessIds: processIds,
        proxyRunning: true,
        proxyOwnedByCompanion: true,
        stopProxyOnClose: false,
        now: 2_000,
      }, state);
      expect(decided.action).toBe("wait");
      expect(decided.state.codexProcessIds).toEqual(processIds);
      expect(decided.state.startedByCompanion).toBe(true);
      state = decided.state;
    }
  });

  test("does not recycle while old and new Codex process sets overlap", () => {
    const first = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [101, 102], proxyRunning: true, now: 1_000 },
      OWNED,
    );
    const overlap = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [102, 202], proxyRunning: true, now: 2_000 },
      first.state,
    );

    expect(overlap.action).toBe("wait");

    const settled = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [202], proxyRunning: true, now: 3_000 },
      overlap.state,
    );
    expect(settled.action).toBe("wait");
  });

  test("never recycles a foreign proxy after a Codex PID replacement", () => {
    const first = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [101], proxyRunning: true, now: 1_000 },
      FOREIGN,
    );
    const replacement = decideCompanionAction(
      { codexRunning: true, codexProcessIds: [202], proxyRunning: true, now: 2_000 },
      first.state,
    );

    expect(replacement.action).toBe("wait");
    expect(replacement.state.startedByCompanion).toBe(false);
  });

  test("an explicit foreign runtime marker overrides a stale in-memory ownership claim", () => {
    const replacement = decideCompanionAction(
      {
        codexRunning: true,
        codexProcessIds: [202],
        proxyRunning: true,
        proxyOwnedByCompanion: false,
        now: 2_000,
      },
      { ...OWNED, codexProcessIds: [101] },
    );

    expect(replacement.action).toBe("wait");
    expect(replacement.state.startedByCompanion).toBe(false);
    expect(replacement.state.codexProcessIds).toEqual([202]);
  });

  test("releases the model even under a proxy it did not start", () => {
    // Deliberate reversal. Ownership protects someone else's *process*; the model is ~22 GB
    // whose only justification for being resident is a client using it. Gating release on
    // ownership left the model pinned forever whenever the proxy came up by hand or via
    // `ocx service` — the symptom this change exists to fix.
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 10_000_000 },
      FOREIGN,
    );
    expect(decided.action).toBe("release-model");
    // Still not ours to stop: the proxy claim must not be invented by releasing the model.
    expect(decided.state.startedByCompanion).toBe(false);
  });

  test("does NOT release a model when Codex was never seen", () => {
    // Loaded for something other than Codex (dashboard Start, another client). Yanking it at
    // companion startup would be a surprise; the server-side idle sweep reclaims that case.
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 10_000_000 },
      { codexLastSeenAt: null, startedByCompanion: false, modelReleased: false },
    );
    expect(decided.action).toBe("wait");
  });

  test("drops its claim when the proxy disappears on its own", () => {
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: false, now: 3_000 },
      OWNED,
    );
    expect(decided.action).toBe("wait");
    expect(decided.state.startedByCompanion).toBe(false);
  });

  test("recovers its claim from durable companion provenance after a liveness miss", () => {
    const missed = decideCompanionAction(
      { codexRunning: false, proxyRunning: false, now: 3_000 },
      OWNED,
    );
    expect(missed.state.startedByCompanion).toBe(false);

    const recovered = decideCompanionAction(
      {
        codexRunning: false,
        proxyRunning: true,
        proxyOwnedByCompanion: true,
        now: 1_000 + COMPANION_LINGER_MS,
      },
      missed.state,
    );
    expect(recovered.action).toBe("release-model");
    expect(recovered.state.startedByCompanion).toBe(true);

    const stopped = decideCompanionAction(
      {
        codexRunning: false,
        proxyRunning: true,
        proxyOwnedByCompanion: true,
        now: 2_000_000,
      },
      recovered.state,
    );
    expect(stopped.action).toBe("stop-proxy");
  });

  test("does not stop a proxy that was already up before Codex was ever seen", () => {
    const decided = decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 500 },
      initialCompanionState(),
    );
    expect(decided.action).toBe("wait");
  });

  test("is pure — the caller's state object is never mutated", () => {
    const before = { ...OWNED };
    decideCompanionAction(
      { codexRunning: false, proxyRunning: true, now: 10_000_000 },
      OWNED,
    );
    expect(OWNED).toEqual(before);
  });
});

describe("runCodexCompanion", () => {
  test("drives a full open-then-close cycle and stops its proxy after release", async () => {
    const actions: string[] = [];
    let tick = 0;
    let codexRunning = true;
    let proxyRunning = false;
    let now = 0;

    await runCodexCompanion({
      codexIsRunning: async () => codexRunning,
      proxyIsRunning: async () => proxyRunning,
      startProxy: async () => { actions.push("start"); proxyRunning = true; },
      releaseModel: async () => { actions.push("release"); },
      stopProxy: async () => { actions.push("stop"); proxyRunning = false; },
      now: () => now,
      sleep: async () => {
        tick += 1;
        now += COMPANION_LINGER_MS; // jump past the linger window each tick
        if (tick === 2) codexRunning = false;
      },
      log: () => {},
      shouldContinue: () => tick < 4,
    });

    expect(actions).toEqual(["start", "release", "stop"]);
    expect(proxyRunning).toBe(false);
  });

  test("a failing start is retried rather than killing the loop", async () => {
    let attempts = 0;
    let tick = 0;
    const logs: string[] = [];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      proxyIsRunning: async () => false,
      startProxy: async () => { attempts += 1; throw new Error("spawn refused"); },
      releaseModel: async () => {},
      stopProxy: async () => {},
      now: () => 0,
      sleep: async () => { tick += 1; },
      log: message => logs.push(message),
      shouldContinue: () => tick < 3,
    });

    expect(attempts).toBe(3);
    expect(logs.some(line => line.includes("spawn refused"))).toBe(true);
  });

  test("dispatches one graceful proxy recycle for a quick Codex replacement", async () => {
    const actions: string[] = [];
    let tick = 0;
    const processIds = [[101], [202], [202]];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => processIds[Math.min(tick, processIds.length - 1)]!,
      proxyIsRunning: async () => true,
      proxyOwnedByCompanion: () => true,
      startProxy: async () => { actions.push("start"); },
      restartProxy: async () => { actions.push("restart"); },
      releaseModel: async () => { actions.push("release"); },
      stopProxy: async () => { actions.push("stop"); },
      now: () => tick * 1_000,
      sleep: async () => { tick += 1; },
      log: () => {},
      shouldContinue: () => tick < 3,
    });

    expect(actions).toEqual(["restart"]);
  });

  test("never replays a failed recycle for the same Codex generation", async () => {
    let tick = 0;
    let restartAttempts = 0;
    const processIds = [[101], [202], [202], [202]];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => processIds[Math.min(tick, processIds.length - 1)]!,
      proxyIsRunning: async () => true,
      proxyOwnedByCompanion: () => true,
      startProxy: async () => {},
      restartProxy: async () => {
        restartAttempts += 1;
        throw new Error("restart result uncertain");
      },
      releaseModel: async () => {},
      stopProxy: async () => {},
      now: () => tick * 1_000,
      sleep: async () => { tick += 1; },
      log: () => {},
      shouldContinue: () => tick < 4,
    });

    expect(restartAttempts).toBe(1);
  });

  test("keep-proxy-running preserves a live proxy across adoption, close and reopen", async () => {
    const actions: string[] = [];
    const processIds = [[101], [], [], [202], [202]];
    let tick = 0;
    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => processIds[tick]!,
      proxyIsRunning: async () => true,
      proxyOwnedByCompanion: () => true,
      startProxy: async () => { actions.push("start"); },
      restartProxy: async () => { actions.push("restart"); },
      releaseModel: async () => { actions.push("release"); },
      stopProxy: async () => { actions.push("stop"); },
      stopProxyOnClose: false,
      now: () => tick * (COMPANION_LINGER_MS + 1),
      sleep: async () => { tick += 1; },
      log: () => {},
      shouldContinue: () => tick < processIds.length,
    });
    expect(actions).toEqual(["release"]);
  });

  test("retries only an idle-gated busy recycle for the same Codex generation", async () => {
    let tick = 0;
    let restartAttempts = 0;
    const processIds = [[101], [202], [202], [202]];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => processIds[Math.min(tick, processIds.length - 1)]!,
      proxyIsRunning: async () => true,
      proxyOwnedByCompanion: () => true,
      startProxy: async () => {},
      restartProxy: async () => {
        restartAttempts += 1;
        return restartAttempts < 3 ? "busy" : undefined;
      },
      releaseModel: async () => {},
      stopProxy: async () => {},
      now: () => tick * 1_000,
      sleep: async () => { tick += 1; },
      log: () => {},
      shouldContinue: () => tick < 4,
    });

    expect(restartAttempts).toBe(3);
  });

  test("does not recycle after a foreign proxy replaces one started by the companion", async () => {
    const actions: string[] = [];
    let tick = 0;
    const processIds = [[101], [101], [202]];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => processIds[Math.min(tick, processIds.length - 1)]!,
      proxyIsRunning: async () => tick > 0,
      proxyOwnedByCompanion: () => false,
      startProxy: async () => { actions.push("start"); },
      restartProxy: async () => { actions.push("restart"); },
      releaseModel: async () => { actions.push("release"); },
      stopProxy: async () => { actions.push("stop"); },
      now: () => tick * 1_000,
      sleep: async () => { tick += 1; },
      log: () => {},
      shouldContinue: () => tick < 3,
    });

    expect(actions).toEqual(["start"]);
  });

  test("a failed process observation pauses safely and the loop keeps running", async () => {
    let tick = 0;
    const actions: string[] = [];
    const logs: string[] = [];

    await runCodexCompanion({
      codexIsRunning: async () => true,
      codexProcessIds: async () => {
        if (tick === 1) throw new Error("process probe unavailable");
        return [101];
      },
      proxyIsRunning: async () => true,
      proxyOwnedByCompanion: () => true,
      startProxy: async () => { actions.push("start"); },
      restartProxy: async () => { actions.push("restart"); },
      releaseModel: async () => { actions.push("release"); },
      stopProxy: async () => { actions.push("stop"); },
      now: () => tick * 100_000,
      sleep: async () => { tick += 1; },
      log: message => logs.push(message),
      shouldContinue: () => tick < 3,
    });

    expect(actions).toEqual([]);
    expect(logs.some(line => line.includes("process probe unavailable"))).toBe(true);
  });
});

describe("runningCodexImages", () => {
  test("falls back to Get-Process when tasklist is access denied", () => {
    const calls: string[] = [];
    setCompanionProcessQueryRunnerForTests((kind) => {
      calls.push(kind);
      if (kind === "tasklist") {
        return { success: false, stdout: "ERROR: Access denied\r\n" };
      }
      return { success: true, stdout: "explorer.exe\t44\r\ncodex.exe\t15692\r\n" };
    });

    expect(runningCodexImages(["codex.exe"])).toEqual(["codex.exe"]);
    expect(calls).toEqual(["tasklist", "powershell"]);
  });

  test("returns stable sorted Codex process identities from tasklist CSV", () => {
    setCompanionProcessQueryRunnerForTests(() => ({
      success: true,
      stdout: [
        '"codex.exe","202","Console","1","10,000 K"',
        '"codex.exe","101","Console","1","10,000 K"',
      ].join("\r\n"),
    }));

    expect(runningCodexProcesses(["codex.exe"])).toEqual([
      { imageName: "codex.exe", pid: 101 },
      { imageName: "codex.exe", pid: 202 },
    ]);
  });

  test("returns stable sorted Codex process identities from the fixed PowerShell fallback", () => {
    setCompanionProcessQueryRunnerForTests((kind) => kind === "tasklist"
      ? { success: false, stdout: "ERROR: Access denied\r\n" }
      : { success: true, stdout: "codex.exe\t202\r\nexplorer.exe\t44\r\ncodex.exe\t101\r\n" });

    expect(runningCodexProcesses(["codex.exe"])).toEqual([
      { imageName: "codex.exe", pid: 101 },
      { imageName: "codex.exe", pid: 202 },
    ]);
  });

  test("fails closed when both Windows process probes fail", () => {
    setCompanionProcessQueryRunnerForTests(() => ({ success: false, stdout: "" }));
    expect(() => runningCodexProcesses(["codex.exe"]))
      .toThrow("Codex process observation unavailable");
  });
});

describe("restartCompanionProxy", () => {
  const ownedTarget = {
    pid: 111,
    port: 10100,
    hostname: "127.0.0.1",
    source: "runtime" as const,
    lifecycleOwner: "codex-companion" as const,
  };

  test("rejects a foreign target before sending a restart request", async () => {
    let requested = false;
    await expect(restartCompanionProxy({
      findLive: async () => ({ ...ownedTarget, lifecycleOwner: undefined }),
      requestRestart: async () => { requested = true; return { accepted: true }; },
    })).rejects.toThrow("companion-owned restart target is unavailable");
    expect(requested).toBe(false);
  });

  test("propagates a definite restart rejection without polling replacement", async () => {
    let probes = 0;
    await expect(restartCompanionProxy({
      findLive: async () => { probes += 1; return ownedTarget; },
      requestRestart: async () => ({
        accepted: false,
        uncertain: false,
        error: new Error("restart denied"),
      }),
    })).rejects.toThrow("restart denied");
    expect(probes).toBe(1);
  });

  test("maps only the server busy response to a retryable result", async () => {
    expect(await restartCompanionProxy({
      findLive: async () => ownedTarget,
      requestRestart: async () => ({
        accepted: false,
        uncertain: false,
        error: new Error("restart_request_http_423"),
      }),
    })).toBe("busy");
  });

  test("accepts only a new companion-owned PID on the same port", async () => {
    const observations = [
      ownedTarget,
      ownedTarget,
      { ...ownedTarget, pid: 222 },
    ];
    let index = 0;
    let now = 0;
    await restartCompanionProxy({
      findLive: async () => observations[Math.min(index++, observations.length - 1)]!,
      requestRestart: async () => ({ accepted: true }),
      now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(index).toBe(3);
  });

  test("keeps observing after a transient replacement probe failure", async () => {
    let probe = 0;
    let restartRequests = 0;
    let now = 0;
    await restartCompanionProxy({
      findLive: async () => {
        probe += 1;
        if (probe === 1) return ownedTarget;
        if (probe === 2) throw new Error("temporary liveness miss");
        return { ...ownedTarget, pid: 222 };
      },
      requestRestart: async () => {
        restartRequests += 1;
        return { accepted: true };
      },
      now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(restartRequests).toBe(1);
    expect(probe).toBe(3);
  });

  test("fails when replacement identity never becomes valid", async () => {
    let now = 0;
    await expect(restartCompanionProxy({
      findLive: async () => ownedTarget,
      requestRestart: async () => ({ accepted: true }),
      now: () => now,
      sleep: async ms => { now += Math.max(ms, 200_000); },
    })).rejects.toThrow("replacement did not become healthy");
  });
});
