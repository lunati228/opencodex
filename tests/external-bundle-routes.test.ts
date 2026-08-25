import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { EXTERNAL_PROVIDER_BUNDLE_REFS } from "../src/providers/external-bundles";
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
  } as unknown as OcxConfig;
}

async function request(method: string, body: unknown, cfg: OcxConfig): Promise<Response> {
  const req = new Request("http://localhost/api/external-bundles", {
    method,
    headers: body === undefined
      ? { host: "localhost" }
      : { "content-type": "application/json", host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, {
    saveConfigPreservingClaudeCode: () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("external provider bundles", () => {
  // The bundled NVIDIA credentials ship inert and only activate once their ref is listed.
  // Nothing could write that list before this route, so the bundles were unreachable.
  test("reports what is enabled and what exists", async () => {
    const response = await request("GET", undefined, config());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: [],
      available: EXTERNAL_PROVIDER_BUNDLE_REFS,
    });
  });

  test("enabling a bundle persists the opt-in", async () => {
    const cfg = config();
    const response = await request("PUT", { refs: ["nvidia-glm-5.2"] }, cfg);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: ["nvidia-glm-5.2"] });
    expect(cfg.externalProviderBundles).toEqual(["nvidia-glm-5.2"]);
  });

  test("an empty list turns every bundle back off", async () => {
    const cfg = config();
    cfg.externalProviderBundles = ["nvidia-glm-5.2"];
    const response = await request("PUT", { refs: [] }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.externalProviderBundles).toEqual([]);
  });

  test("duplicates collapse instead of being stored twice", async () => {
    const cfg = config();
    await request("PUT", { refs: ["nvidia-glm-5.2", "nvidia-glm-5.2"] }, cfg);
    expect(cfg.externalProviderBundles).toEqual(["nvidia-glm-5.2"]);
  });

  // Skipping an unknown ref would report success for a provider that never appears.
  test("an unknown ref is rejected, not silently dropped", async () => {
    const cfg = config();
    const response = await request("PUT", { refs: ["nvidia-glm-5.2", "nvidia-not-a-thing"] }, cfg);
    expect(response.status).toBe(422);
    expect(cfg.externalProviderBundles).toBeUndefined();
  });

  test.each([
    ["missing refs", {}],
    ["refs not an array", { refs: "nvidia-glm-5.2" }],
    ["extra field", { refs: [], secretPath: "C:\\somewhere" }],
  ])("rejects %s", async (_label, body) => {
    const cfg = config();
    const response = await request("PUT", body, cfg);
    expect(response.status).toBe(400);
    expect(cfg.externalProviderBundles).toBeUndefined();
  });

  test("every advertised ref is actually accepted", async () => {
    const cfg = config();
    const response = await request("PUT", { refs: [...EXTERNAL_PROVIDER_BUNDLE_REFS] }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.externalProviderBundles).toEqual([...EXTERNAL_PROVIDER_BUNDLE_REFS]);
  });
});
