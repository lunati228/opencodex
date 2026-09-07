import { describe, expect, test } from "bun:test";
import { ConsumerLeaseRegistry } from "../src/local-runtime/consumer-leases";
import { shouldReleaseIdleLocalRuntime } from "../src/local-runtime/on-demand";

describe("local runtime consumer leases", () => {
  test.each([600_000, -600_000])("heartbeat keeps its 90-second deadline after a %i ms wall-clock correction", correction => {
    let wall = 1_000_000;
    let monotonic = 0;
    const leases = new ConsumerLeaseRegistry(() => wall, () => monotonic);
    const lease = leases.acquire("owner", true)!;
    expect(lease.expiresAt).toBe(wall + 90_000);

    monotonic = 30_000;
    wall += 30_000 + correction;
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 1, modelHolds: 1 });
    expect(leases.status("owner", lease.leaseToken)).toEqual({ expiresAt: wall + 60_000, modelUse: true });
    expect(leases.heartbeat("owner", lease.leaseToken)).toEqual({ expiresAt: wall + 90_000, modelUse: true });

    monotonic = 119_999;
    wall += 89_999;
    expect(leases.status("owner", lease.leaseToken)).toEqual({ expiresAt: wall + 1, modelUse: true });
    monotonic++;
    wall++;
    expect(leases.heartbeat("owner", lease.leaseToken)).toBeNull();
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 0, modelHolds: 0 });
    expect(leases.release("owner", lease.leaseToken)).toBe(true);
  });

  test.each([3_600_000, -3_600_000])("an unrenewed lease expires at 90 seconds despite a %i ms wall-clock correction", correction => {
    let wall = 1_000_000;
    let monotonic = 0;
    const leases = new ConsumerLeaseRegistry(() => wall, () => monotonic);
    const lease = leases.acquire("owner", true)!;
    monotonic = 89_999;
    wall += monotonic + correction;
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 1, modelHolds: 1 });
    monotonic++;
    wall++;
    expect(leases.status("owner", lease.leaseToken)).toBeNull();
    expect(leases.heartbeat("owner", lease.leaseToken)).toBeNull();
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 0, modelHolds: 0 });
  });

  test.each([3_600_000, -3_600_000])("expiry bridges elapsed idle time to Unix milliseconds after a %i ms wall-clock correction", correction => {
    let wall = 1_000_000;
    let monotonic = 5_000;
    const leases = new ConsumerLeaseRegistry(() => wall, () => monotonic);
    leases.acquire("owner", true);
    monotonic += 95_000; // First observation is five seconds after expiry.
    wall += 95_000 + correction;
    expect(leases.snapshot().lastModelUseAt).toBe(wall - 5_000);

    monotonic += 294_999;
    wall += 294_999 - correction; // A second correction must not change idle age.
    expect(leases.snapshot().lastModelUseAt).toBe(wall - 299_999);
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: wall, consumers: leases.snapshot() })).toBe(false);
    monotonic++;
    wall++;
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: wall, consumers: leases.snapshot() })).toBe(true);
  });

  test.each(["release", "heartbeat"] as const)("%s settles the final model use after a backward wall-clock correction", action => {
    let wall = 1_000_000;
    let monotonic = 0;
    const leases = new ConsumerLeaseRegistry(() => wall, () => monotonic);
    const first = leases.acquire("owner-a", true)!;
    const second = leases.acquire("owner-b", true)!;
    monotonic = 30_000;
    wall += 30_000;
    leases.release("owner-a", first.leaseToken);
    monotonic = 60_000;
    wall -= 3_600_000;
    if (action === "release") leases.release("owner-b", second.leaseToken);
    else leases.heartbeat("owner-b", second.leaseToken, false);
    expect(leases.snapshot()).toMatchObject({ modelHolds: 0, lastModelUseAt: wall });
    monotonic += 299_999;
    wall += 299_999;
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: wall, consumers: leases.snapshot() })).toBe(false);
    monotonic++;
    wall++;
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: wall, consumers: leases.snapshot() })).toBe(true);
  });

  test("separates proxy ownership from model use and expires at 90 seconds", () => {
    let now = 1_000;
    const leases = new ConsumerLeaseRegistry(() => now, () => now);
    const lease = leases.acquire("owner-a", true)!;
    expect(lease.expiresAt).toBe(91_000);
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 1, modelHolds: 1 });
    now = 31_000;
    expect(leases.heartbeat("owner-a", lease.leaseToken, false)).toMatchObject({
      expiresAt: 121_000, modelUse: false,
    });
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 1, modelHolds: 0, lastModelUseAt: 31_000 });
    now = 121_000;
    expect(leases.snapshot()).toMatchObject({ proxyHolds: 0, modelHolds: 0 });
    expect(leases.heartbeat("owner-a", lease.leaseToken, true)).toBeNull();
  });

  test("tokens are bound to the owner and release stays idempotent without tombstones", () => {
    const leases = new ConsumerLeaseRegistry(() => 0, () => 0);
    const lease = leases.acquire("owner-a", true)!;
    expect(leases.status("owner-b", lease.leaseToken)).toBeNull();
    expect(leases.heartbeat("owner-b", lease.leaseToken, false)).toBeNull();
    expect(leases.release("owner-b", lease.leaseToken)).toBe(false);
    expect(leases.snapshot().modelHolds).toBe(1);
    expect(leases.release("owner-a", lease.leaseToken)).toBe(true);
    expect(leases.release("owner-a", lease.leaseToken)).toBe(true);
    expect(leases.release("owner-b", lease.leaseToken)).toBe(false);
    expect(leases.release("owner-a", `${lease.leaseToken}x`)).toBe(false);
    expect(leases.snapshot().proxyHolds).toBe(0);
  });

  test("one release cannot settle another active consumer", () => {
    let now = 0;
    const leases = new ConsumerLeaseRegistry(() => now, () => now);
    const first = leases.acquire("owner-a", true)!;
    const second = leases.acquire("owner-b", true)!;
    now = 60_000;
    leases.heartbeat("owner-b", second.leaseToken);
    leases.release("owner-a", first.leaseToken);
    now = 90_000;
    expect(leases.snapshot().modelHolds).toBe(1);
    now = 150_000;
    expect(leases.snapshot()).toMatchObject({ modelHolds: 0, proxyHolds: 0, lastModelUseAt: 150_000 });
  });

  test("crashed consumer expiry starts a five-minute idle window at its actual expiry", () => {
    let now = 0;
    const leases = new ConsumerLeaseRegistry(() => now, () => now);
    leases.acquire("owner", true);
    now = 89_999;
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: 0, now: 999_999, consumers: leases.snapshot() })).toBe(false);
    now = 390_000;
    const consumers = leases.snapshot();
    expect(consumers.lastModelUseAt).toBe(90_000);
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: 389_999, consumers })).toBe(false);
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now, consumers })).toBe(true);
  });

  test("proxy-only ownership does not create model demand or override manual start", () => {
    const leases = new ConsumerLeaseRegistry(() => 0, () => 0);
    leases.acquire("owner", false);
    const consumers = leases.snapshot();
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: null, now: 999_999, consumers })).toBe(false);
    expect(shouldReleaseIdleLocalRuntime({ running: true, lastUsedAt: 0, now: 300_000, consumers })).toBe(true);
  });

  test("bounds live leases and prevents admission while shutdown is reserved", () => {
    const leases = new ConsumerLeaseRegistry(() => 0, () => 0);
    const resume = leases.suspendAcquisition();
    expect(leases.acquire("owner", false)).toBeNull();
    resume();
    resume();
    for (let i = 0; i < 128; i++) expect(leases.acquire("owner", false)).not.toBeNull();
    expect(leases.acquire("owner", false)).toBeNull();
  });
});
