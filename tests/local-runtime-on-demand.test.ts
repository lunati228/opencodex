import { afterEach, describe, expect, test } from "bun:test";
import { trackStreamLifetime } from "../src/server/lifecycle";
import {
  LOCAL_RUNTIME_IDLE_RELEASE_MS,
  acquireManagedLocalRuntimeUse,
  clearLocalRuntimeUse,
  ensureLocalRuntimeReady,
  localRuntimeActiveUseCount,
  localRuntimeLastUsedAt,
  localRuntimeUseOnDone,
  noteLocalRuntimeUse,
  shouldReleaseIdleLocalRuntime,
} from "../src/local-runtime/on-demand";

afterEach(() => clearLocalRuntimeUse());

describe("idle release decision", () => {
  test("releases once the idle window has fully elapsed", () => {
    expect(shouldReleaseIdleLocalRuntime({
      running: true, lastUsedAt: 0, now: LOCAL_RUNTIME_IDLE_RELEASE_MS,
    })).toBe(true);
  });

  test("does not release one millisecond early", () => {
    expect(shouldReleaseIdleLocalRuntime({
      running: true, lastUsedAt: 0, now: LOCAL_RUNTIME_IDLE_RELEASE_MS - 1,
    })).toBe(false);
  });

  // The whole reason the window is minutes: a pause between messages must not unload 22 GB.
  test("a long pause between messages inside the window keeps the model resident", () => {
    const fourMinutes = 4 * 60_000;
    expect(shouldReleaseIdleLocalRuntime({
      running: true, lastUsedAt: 0, now: fourMinutes,
    })).toBe(false);
  });

  test("never releases an engine that is already down", () => {
    expect(shouldReleaseIdleLocalRuntime({
      running: false, lastUsedAt: 0, now: 10_000_000,
    })).toBe(false);
  });

  // Started by the dashboard or a leftover autoStart rather than by a request. Releasing that
  // out from under an operator who pressed Start would be a surprise.
  test("never releases a model that no request ever used", () => {
    expect(shouldReleaseIdleLocalRuntime({
      running: true, lastUsedAt: null, now: 10_000_000,
    })).toBe(false);
  });
});

describe("use tracking", () => {
  test("starts unused and records the latest use", () => {
    expect(localRuntimeLastUsedAt()).toBeNull();
    noteLocalRuntimeUse(500);
    expect(localRuntimeLastUsedAt()).toBe(500);
    noteLocalRuntimeUse(900);
    expect(localRuntimeLastUsedAt()).toBe(900);
  });

  test("clearing makes the engine ineligible again until the next request", () => {
    noteLocalRuntimeUse(500);
    clearLocalRuntimeUse();
    expect(shouldReleaseIdleLocalRuntime({
      running: true, lastUsedAt: localRuntimeLastUsedAt(), now: 10_000_000,
    })).toBe(false);
  });
});

describe("managed local runtime request leases", () => {
  test("does not release a request that remains active past six minutes", () => {
    const lease = acquireManagedLocalRuntimeUse();
    noteLocalRuntimeUse(0);

    expect(localRuntimeActiveUseCount()).toBe(1);
    expect(shouldReleaseIdleLocalRuntime({
      running: true,
      lastUsedAt: localRuntimeLastUsedAt(),
      now: 6 * 60_000,
    })).toBe(false);

    lease.release(6 * 60_000);
    expect(localRuntimeActiveUseCount()).toBe(0);
    expect(localRuntimeLastUsedAt()).toBe(6 * 60_000);
  });

  test("stamps last use only when the final concurrent lease settles", () => {
    const first = acquireManagedLocalRuntimeUse();
    const second = acquireManagedLocalRuntimeUse();

    first.release(1_000);
    expect(localRuntimeActiveUseCount()).toBe(1);
    expect(localRuntimeLastUsedAt()).toBeNull();

    second.release(2_000);
    expect(localRuntimeActiveUseCount()).toBe(0);
    expect(localRuntimeLastUsedAt()).toBe(2_000);
  });

  test("settles an individual lease exactly once", () => {
    const lease = acquireManagedLocalRuntimeUse();

    lease.release(1_000);
    lease.release(2_000);

    expect(localRuntimeActiveUseCount()).toBe(0);
    expect(localRuntimeLastUsedAt()).toBe(1_000);
  });

  test("releases a lease when a tracked stream completes", async () => {
    const lease = acquireManagedLocalRuntimeUse();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const tracked = trackStreamLifetime(
      stream,
      new AbortController(),
      localRuntimeUseOnDone(lease),
    );

    const reader = tracked.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(true);
    expect(localRuntimeActiveUseCount()).toBe(0);
  });

  test("releases a lease when a tracked stream is cancelled", async () => {
    const lease = acquireManagedLocalRuntimeUse();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tracked = trackStreamLifetime(
      stream,
      new AbortController(),
      localRuntimeUseOnDone(lease),
    );

    const reader = tracked.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(cancelled).toBe(true);
    expect(localRuntimeActiveUseCount()).toBe(0);
  });

  test("releases a lease when a tracked stream errors", async () => {
    const lease = acquireManagedLocalRuntimeUse();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("synthetic upstream failure");
      },
    });
    const tracked = trackStreamLifetime(
      stream,
      new AbortController(),
      localRuntimeUseOnDone(lease),
    );

    await expect(tracked.getReader().read()).rejects.toThrow("synthetic upstream failure");
    expect(localRuntimeActiveUseCount()).toBe(0);
  });

  test("releases a lease when terminal cleanup throws", () => {
    const lease = acquireManagedLocalRuntimeUse();
    const onDone = localRuntimeUseOnDone(lease, () => {
      throw new Error("synthetic cleanup failure");
    });

    expect(onDone).toThrow("synthetic cleanup failure");
    expect(localRuntimeActiveUseCount()).toBe(0);
  });
});

describe("ensureLocalRuntimeReady", () => {
  function clock() {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => { now += ms; } };
  }

  test("a routable engine is never started again", async () => {
    let starts = 0;
    const result = await ensureLocalRuntimeReady({
      canRoute: () => true, requestStart: () => { starts += 1; }, ...clock(),
    });
    expect(result).toBe("already-ready");
    expect(starts).toBe(0);
  });

  test("starts a stopped engine and waits for it to become routable", async () => {
    let starts = 0;
    let ready = false;
    const c = clock();
    const result = await ensureLocalRuntimeReady({
      canRoute: () => ready,
      requestStart: () => { starts += 1; ready = false; },
      now: c.now,
      sleep: async ms => { await c.sleep(ms); if (c.now() >= 2_000) ready = true; },
    });
    expect(result).toBe("started");
    // One start, not one per poll — a duplicated load would be catastrophic at this size.
    expect(starts).toBe(1);
  });

  test("gives up with a retryable timeout rather than hanging forever", async () => {
    const result = await ensureLocalRuntimeReady({
      canRoute: () => false, requestStart: () => {}, ...clock(), timeoutMs: 5_000,
    });
    expect(result).toBe("timeout");
  });

  test("an engine that becomes ready exactly at the deadline still counts as started", async () => {
    const c = clock();
    let ready = false;
    const result = await ensureLocalRuntimeReady({
      canRoute: () => ready,
      requestStart: () => {},
      now: c.now,
      sleep: async ms => { await c.sleep(ms); if (c.now() >= 5_000) ready = true; },
      timeoutMs: 5_000,
    });
    expect(result).toBe("started");
  });
});
