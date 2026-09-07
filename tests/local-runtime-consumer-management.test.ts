import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ConsumerLeaseRegistry } from "../src/local-runtime/consumer-leases";
import { handleLocalRuntimeRoutes } from "../src/server/management/local-runtime-routes";
import { handleManagementAPI } from "../src/server/management-api";
import { managementPrincipal, requireManagementAuth, type ManagementAuthState } from "../src/server/management-auth";
import { LOCAL_RUNTIME_MODEL_ID, LOCAL_RUNTIME_PROFILE_ID, managedLocalProviderProjection } from "../src/local-runtime/profile";
import { QWEN_DEFAULT_CONTEXT } from "../src/local-runtime/context-tiers";
import type { OcxConfig } from "../src/types";
import type { LocalRuntimeControl, LocalRuntimeStatus } from "../src/local-runtime/supervisor";
import { acquireManagedLocalRuntimeUse } from "../src/local-runtime/on-demand";

function fixture() {
  let now = 0;
  const leases = new ConsumerLeaseRegistry(() => now, () => now);
  const owner = randomBytes(32).toString("base64url");
  const auth: ManagementAuthState = {
    available: true, token: randomBytes(32).toString("base64url"), source: "environment",
    sessions: new Map(), pairingGrants: new Map(),
  };
  const config: OcxConfig = {
    port: 10100, defaultProvider: "qwen-local",
    providers: { "qwen-local": managedLocalProviderProjection(QWEN_DEFAULT_CONTEXT) },
    localRuntime: { enabled: true, autoStart: false, profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
  };
  const candidate = { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT, reasoningEffort: "xhigh" as const };
  const state: LocalRuntimeStatus = {
    state: "running", revision: 1, requested: candidate, lastKnownGood: candidate,
    effective: { ...candidate, model: LOCAL_RUNTIME_MODEL_ID, verifiedAt: new Date(0).toISOString() },
    failure: null, pid: 4000, operationPending: false,
  };
  let starts = 0;
  let stops = 0;
  const supervisor: LocalRuntimeControl = {
    status: () => state,
    canRoute: () => state.state === "running" && !state.operationPending,
    requestStart: () => { starts++; state.state = "starting"; state.operationPending = true; return { accepted: true, revision: 2 }; },
    requestStop: () => { stops++; return { accepted: true, revision: 2 }; },
    requestApply: () => { stops++; return { accepted: true, revision: 2 }; },
    whenIdle: async () => {}, shutdown: async () => {},
  };
  async function request(action: string, body: unknown = {}, opts: { owner?: string; authenticated?: boolean; path?: string; method?: string } = {}) {
    const req = new Request(`http://127.0.0.1:10100${opts.path ?? `/api/local-runtime/v1/leases/${action}`}`, {
      method: opts.method ?? "POST",
      headers: { host: "127.0.0.1:10100", "content-type": "application/json", "x-ocx-consumer-owner": opts.owner ?? owner,
        ...(opts.authenticated === false ? {} : { authorization: `Bearer ${auth.token}` }) },
      body: opts.method === "GET" ? undefined : JSON.stringify(body),
    });
    const denied = requireManagementAuth(req, auth, config);
    if (denied) return denied;
    return (await handleLocalRuntimeRoutes({
      req, url: new URL(req.url), config, version: "test", deps: { localRuntimeSupervisor: supervisor, localRuntimeConsumerLeases: leases },
      principal: managementPrincipal(req, auth, config)!, convergeCodexCatalog: async () => "not-needed" as never,
      syncClaudeAgentDefsBestEffort: async () => {},
    }))!;
  }
  return { leases, owner, config, state, supervisor, request, setNow: (value: number) => { now = value; }, starts: () => starts, stops: () => stops };
}

describe("authenticated consumer management v1", () => {
  test("a queued managed request also blocks companion proxy shutdown", async () => {
    const f = fixture();
    const use = acquireManagedLocalRuntimeUse();
    try {
      const req = new Request("http://127.0.0.1/api/stop?keep-codex-routing=1", { method: "POST", headers: { host: "127.0.0.1" } });
      const response = await handleManagementAPI(req, new URL(req.url), f.config, { localRuntimeConsumerLeases: f.leases });
      expect(response!.status).toBe(409);
      expect(await response!.json()).toMatchObject({ code: "consumer_in_use" });
    } finally { use.release(); }
  });

  test("acquires a sanitized direct-local descriptor and binds tokens to the client", async () => {
    const f = fixture();
    const response = await f.request("acquire", { modelUse: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ version: 1, ttlMs: 90_000, heartbeatMs: 30_000, modelUse: true, expiresAt: 90_000,
      runtime: { endpoint: "http://127.0.0.1:8080/v1", model: LOCAL_RUNTIME_MODEL_ID, contextWindow: QWEN_DEFAULT_CONTEXT, reasoningEffort: "xhigh" } });
    expect(Object.keys(body.runtime).sort()).toEqual(["contextWindow", "endpoint", "model", "reasoningEffort"]);
    expect((await f.request("heartbeat", { leaseToken: body.leaseToken }, { owner: randomBytes(32).toString("base64url") })).status).toBe(404);
    const status = await (await f.request("status", { leaseToken: body.leaseToken })).json();
    expect(status.leaseToken).toBeUndefined();
    expect((await f.request("release", { leaseToken: body.leaseToken })).status).toBe(200);
    expect((await f.request("release", { leaseToken: body.leaseToken })).status).toBe(200);
    expect(f.leases.snapshot().proxyHolds).toBe(0);
  });

  test("requires management admission, owner entropy shape, exact fields and body-only tokens", async () => {
    const f = fixture();
    expect((await f.request("acquire", { modelUse: true }, { authenticated: false })).status).toBe(401);
    expect((await f.request("acquire", { modelUse: true }, { owner: "client-name" })).status).toBe(400);
    expect((await f.request("acquire", { modelUse: true, provider: "cloud" })).status).toBe(400);
    expect((await f.request("status", {}, { method: "GET" })).status).toBe(405);
    expect((await f.request("acquire", { modelUse: true }, { path: "/api/local-runtime/v1/leases/acquire?token=value" })).status).toBe(400);
    expect(f.leases.snapshot().proxyHolds).toBe(0);
  });

  test("returns pending with no endpoint during a bounded supervised cold start", async () => {
    const f = fixture();
    f.state.state = "stopped"; f.state.effective = null; f.state.pid = null;
    const response = await f.request("acquire", { modelUse: true });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.runtime).toBeNull();
    expect(f.starts()).toBe(1);
    f.setNow(30_000);
    const heartbeat = await f.request("heartbeat", { leaseToken: body.leaseToken });
    expect(heartbeat.status).toBe(202);
    expect((await heartbeat.json()).expiresAt).toBe(120_000);
    expect(f.starts()).toBe(1);
  });

  test("rejects foreign, disabled and unverified runtime identities without publishing a descriptor", async () => {
    for (const invalid of ["provider", "disabled", "model", "context", "reasoning", "proof", "foreign"] as const) {
      const f = fixture();
      if (invalid === "provider") f.config.providers["qwen-local"]!.baseUrl = "https://example.com";
      if (invalid === "disabled") f.config.localRuntime!.enabled = false;
      if (invalid === "model") f.state.effective!.model = "unverified";
      if (invalid === "context") f.state.effective!.nCtx = 123;
      if (invalid === "reasoning") f.state.effective!.reasoningEffort = "high" as never;
      if (invalid === "proof") f.state.effective!.verifiedAt = "";
      if (invalid === "foreign") { f.state.state = "blocked-foreign-port"; f.state.failure = "foreign-port"; }
      const response = await f.request("acquire", { modelUse: true });
      expect(response.status).toBe(503);
      expect((await response.json()).runtime).toBeUndefined();
      expect(f.leases.snapshot().proxyHolds).toBe(0);
    }
  });

  test("heartbeat may relinquish model use while keeping proxy ownership; expired heartbeat cannot revive", async () => {
    const f = fixture();
    const { leaseToken } = await (await f.request("acquire", { modelUse: true })).json();
    f.setNow(30_000);
    expect((await f.request("heartbeat", { leaseToken, modelUse: false })).status).toBe(200);
    expect(f.leases.snapshot()).toMatchObject({ proxyHolds: 1, modelHolds: 0 });
    f.setNow(120_000);
    expect((await f.request("heartbeat", { leaseToken, modelUse: true })).status).toBe(404);
    expect((await f.request("release", { leaseToken })).status).toBe(200);
  });

  test("active consumer blocks legacy model stop/apply and proxy stop before any side effects", async () => {
    const f = fixture();
    await f.request("acquire", { modelUse: true });
    expect((await f.request("", {}, { path: "/api/local-runtime/stop" })).status).toBe(409);
    expect((await f.request("", { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT, expectedRevision: 1 }, { path: "/api/local-runtime/apply" })).status).toBe(409);
    const req = new Request("http://127.0.0.1/api/stop", { method: "POST", headers: { host: "127.0.0.1" } });
    const stop = await handleManagementAPI(req, new URL(req.url), f.config, { localRuntimeConsumerLeases: f.leases });
    expect(stop!.status).toBe(409);
    expect(f.stops()).toBe(0);
  });
});
