import { describe, expect, test } from "bun:test";
import { runCodexCompanion } from "../src/codex/companion";

describe("companion respects busy lifecycle operations", () => {
  test("a refused model release is retried without stopping the proxy", async () => {
    let tick = 0;
    let releases = 0;
    let stops = 0;
    await runCodexCompanion({
      codexIsRunning: async () => tick === 0, proxyIsRunning: async () => tick !== 0,
      startProxy: async () => {},
      releaseModel: async () => { releases++; return "busy"; },
      stopProxy: async () => { stops++; }, now: () => tick * 30_000,
      sleep: async () => { tick++; }, log: () => {}, shouldContinue: () => tick < 4,
    });
    expect(releases).toBe(3);
    expect(stops).toBe(0);
  });

  test("a refused proxy stop retains ownership and retries after the lease ends", async () => {
    let tick = 0;
    let attempts = 0;
    await runCodexCompanion({
      codexIsRunning: async () => tick === 0, proxyIsRunning: async () => tick !== 0,
      startProxy: async () => {}, releaseModel: async () => {},
      stopProxy: async () => { attempts++; return attempts === 1 ? "busy" : undefined; },
      now: () => tick * 30_000, sleep: async () => { tick++; }, log: () => {}, shouldContinue: () => tick < 4,
    });
    expect(attempts).toBe(2);
  });
});
