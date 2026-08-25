import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import {
  LOCAL_RUNTIME_PROFILE_ID,
  LOCAL_RUNTIME_PROVIDER_ID,
  managedLocalProviderProjection,
} from "../src/local-runtime/profile";
import { QWEN_CONTEXT_VARIANTS, QWEN_DEFAULT_CONTEXT } from "../src/local-runtime/context-tiers";
import { managedLocalRuntimeProviderIsValid } from "../src/local-runtime/production";
import type {
  LocalRuntimeControl,
  LocalRuntimeMutationResult,
  LocalRuntimeStatus,
} from "../src/local-runtime/supervisor";
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
      [LOCAL_RUNTIME_PROVIDER_ID]: managedLocalProviderProjection(QWEN_DEFAULT_CONTEXT),
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

function fakeController() {
  const calls: unknown[] = [];
  let revision = 4;
  const baseStatus = (): LocalRuntimeStatus => ({
    state: "running",
    revision,
    requested: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
    effective: {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: QWEN_DEFAULT_CONTEXT,
      model: "huihui-qwen3.8-27b-abliterated-q6-k-l",
      verifiedAt: "2026-07-27T00:00:00.000Z",
    },
    lastKnownGood: { profileId: LOCAL_RUNTIME_PROFILE_ID, nCtx: QWEN_DEFAULT_CONTEXT },
    failure: null,
    pid: 4000,
    operationPending: false,
  });
  const accepted = (): LocalRuntimeMutationResult => ({
    accepted: true,
    revision: ++revision,
  });
  const controller: LocalRuntimeControl = {
    status: () => baseStatus(),
    requestStart: cfg => {
      calls.push(["start", cfg]);
      return accepted();
    },
    requestApply: (_cfg, input) => {
      calls.push(["apply", input]);
      if (
        input.profileId !== LOCAL_RUNTIME_PROFILE_ID
        || !QWEN_CONTEXT_VARIANTS.some(variant => variant.contextWindow === input.nCtx)
      ) {
        return { accepted: false, reason: "invalid-candidate", revision };
      }
      return accepted();
    },
    requestStop: () => {
      calls.push(["stop"]);
      return accepted();
    },
    whenIdle: async () => {},
    canRoute: () => true,
    shutdown: async () => {},
  };
  return { controller, calls };
}

async function request(
  method: string,
  path: string,
  body: unknown,
  controller: LocalRuntimeControl,
  // Optional so a caller can observe what the handler wrote back; every existing test
  // gets a throwaway config exactly as before.
  cfg: OcxConfig = config(),
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined
      ? { host: "localhost" }
      : { "content-type": "application/json", host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(
    req,
    new URL(req.url),
    cfg,
    {
      localRuntimeSupervisor: controller,
      saveConfigPreservingClaudeCode: () => {},
    },
  );
  expect(response).not.toBeNull();
  return response!;
}

describe("managed local runtime management API", () => {
  test("exposes only safe requested/effective/LKG process status", async () => {
    const { controller } = fakeController();
    const response = await request(
      "GET",
      "/api/local-runtime/status",
      undefined,
      controller,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      state: "running",
      requested: { profileId: "qwen38-27b-q6kl", nCtx: QWEN_DEFAULT_CONTEXT },
      effective: { nCtx: QWEN_DEFAULT_CONTEXT },
      lastKnownGood: { nCtx: QWEN_DEFAULT_CONTEXT },
      contextConstraints: { min: 16384, max: 184320, step: 1024 },
      contextCheckpoints: QWEN_CONTEXT_VARIANTS.map(variant => variant.contextWindow),
      reasoningEfforts: ["off", "low", "medium", "xhigh"],
      profiles: [{
        id: "qwen38-27b-q6kl",
        reasoningEfforts: ["off", "low", "medium", "xhigh"],
      }],
      controlEnabled: true,
    });
    expect(text).not.toContain("C:\\LLMs");
  });

  // Regression: server/index.ts gates the boot-time model load on `autoStart === true`, but
  // `enable` hardcodes it false and `apply` rejects the field, so the gate was unreachable and
  // the runtime could never come up without a manual Start.
  test("autostart persists the flag without touching the runtime", async () => {
    const { controller, calls } = fakeController();
    const cfg = config();
    cfg.localRuntime!.autoStart = false;
    const response = await request(
      "PUT",
      "/api/local-runtime/autostart",
      { enabled: true },
      controller,
      cfg,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ autoStart: true });
    expect(cfg.localRuntime!.autoStart).toBe(true);
    // Flipping the intent must not start or stop anything.
    expect(calls).toHaveLength(0);
  });

  test("autostart can be turned back off", async () => {
    const { controller } = fakeController();
    const cfg = config();
    const response = await request(
      "PUT",
      "/api/local-runtime/autostart",
      { enabled: false },
      controller,
      cfg,
    );
    expect(response.status).toBe(200);
    expect(cfg.localRuntime!.autoStart).toBe(false);
  });

  test.each([
    ["missing enabled", {}],
    ["non-boolean enabled", { enabled: "yes" }],
    ["extra shape", { enabled: true, executable: "C:\\arbitrary.exe" }],
  ])("autostart rejects %s", async (_label, body) => {
    const { controller } = fakeController();
    const cfg = config();
    cfg.localRuntime!.autoStart = false;
    const response = await request("PUT", "/api/local-runtime/autostart", body, controller, cfg);
    expect(response.status).toBe(400);
    expect(cfg.localRuntime!.autoStart).toBe(false);
  });

  test("accepts only the narrow apply shape", async () => {
    const { controller, calls } = fakeController();
    const injected = await request(
      "POST",
      "/api/local-runtime/apply",
      {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: 131072,
        expectedRevision: 4,
        executable: "C:\\arbitrary.exe",
      },
      controller,
    );
    expect(injected.status).toBe(400);
    expect(calls).toHaveLength(0);

    const valid = await request(
      "POST",
      "/api/local-runtime/apply",
      {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: 131072,
        expectedRevision: 4,
      },
      controller,
    );
    expect(valid.status).toBe(202);
    expect(calls).toEqual([[
      "apply",
      {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: 131072,
        expectedRevision: 4,
      },
    ]]);
  });

  test("maps invalid context to 422 without accepting it", async () => {
    const { controller } = fakeController();
    const response = await request(
      "POST",
      "/api/local-runtime/apply",
      {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: 49152,
        expectedRevision: 4,
      },
      controller,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      accepted: false,
      reason: "invalid-candidate",
    });
  });

  test("rejects the retired Ornith profile instead of starting it", async () => {
    const { controller, calls } = fakeController();
    const response = await request(
      "POST",
      "/api/local-runtime/apply",
      {
        profileId: "ornith-balanced",
        nCtx: 8192,
        expectedRevision: 4,
      },
      controller,
    );
    expect(response.status).toBe(422);
    expect(calls).toEqual([[
      "apply",
      { profileId: "ornith-balanced", nCtx: 8192, expectedRevision: 4 },
    ]]);
  });

  test("a missing projection for the configured profile stays not-controlled", () => {
    const cfg = config();
    delete cfg.providers[LOCAL_RUNTIME_PROVIDER_ID];
    expect(managedLocalRuntimeProviderIsValid(cfg)).toBe(false);
  });

  test("keeps the derived local provider read-only", async () => {
    const { controller } = fakeController();
    const patch = await request(
      "PATCH",
      `/api/providers?name=${LOCAL_RUNTIME_PROVIDER_ID}`,
      { disabled: true },
      controller,
    );
    const remove = await request(
      "DELETE",
      `/api/providers?name=${LOCAL_RUNTIME_PROVIDER_ID}`,
      undefined,
      controller,
    );
    expect(patch.status).toBe(409);
    expect(remove.status).toBe(409);
  });
});
