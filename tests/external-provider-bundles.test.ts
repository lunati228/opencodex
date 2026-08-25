import { describe, expect, test } from "bun:test";
import {
  applyExternalProviderBundles,
  clearExternalProviderSecrets,
  externalProviderModelDisplayName,
  resolveExternalProviderSecret,
} from "../src/providers/external-bundles";
import { buildCatalogEntries } from "../src/codex/catalog";
import { gatherRoutedModels } from "../src/codex/catalog/provider-fetch";
import { resolveEnvValue } from "../src/config";
import { safeConfigDTO } from "../src/server/auth-cors";
import { routeModel } from "../src/router";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import type { OcxConfig } from "../src/types";

const ROOT = "C:\\Users\\tester\\.opencodex\\provider-secrets";

function config(refs: string[]): OcxConfig {
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
    externalProviderBundles: refs,
  };
}

function bundle(provider: string, model: string, key: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        disabled: true,
        authMode: "key",
        apiKey: key,
        keyOptional: false,
        defaultModel: model,
        models: [model],
        liveModels: false,
        selectedModels: [model],
        note: "private input note",
        ...extra,
      },
    },
  });
}

function reader(files: Record<string, string>): (path: string) => string {
  return path => {
    const name = path.replaceAll("\\", "/").split("/").at(-1)!;
    if (!(name in files)) throw new Error("bundle-unavailable");
    return files[name]!;
  };
}

describe("external provider bundles", () => {
  test("publishes friendly NVIDIA model names and states that Free still requires the key", async () => {
    const cfg = config(["nvidia-glm-5.2", "nvidia-deepseek-v4-pro"]);
    applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "glm-canary-secret"),
        "deepseek-v4-pro.disabled.json": bundle("nvidia-deepseek-v4-pro", "deepseek-ai/deepseek-v4-pro", "deepseek-canary-secret"),
      }),
    });

    expect(externalProviderModelDisplayName("nvidia-glm-5.2", "z-ai/glm-5.2"))
      .toBe("NVIDIA | GLM 5.2");
    expect(externalProviderModelDisplayName(
      "nvidia-deepseek-v4-pro",
      "deepseek-ai/deepseek-v4-pro",
    )).toBe("NVIDIA | DeepSeek V4 Pro");
    for (const provider of [
      cfg.providers["nvidia-glm-5.2"],
      cfg.providers["nvidia-deepseek-v4-pro"],
    ]) {
      expect(provider).toMatchObject({ freeTier: true, keyOptional: false });
      expect(provider?.note).toContain("API key is required");
    }

    const models = await gatherRoutedModels(cfg);
    expect(models.find(model => model.provider === "nvidia-glm-5.2")?.displayName)
      .toBe("NVIDIA | GLM 5.2");
    expect(models.find(model => model.provider === "nvidia-deepseek-v4-pro")?.displayName)
      .toBe("NVIDIA | DeepSeek V4 Pro");
  });

  test("caps the managed NVIDIA GLM catalog row below its model-native 1M window", async () => {
    const modelNativeContextWindow = 1_000_000;
    const nvidiaEndpointContextWindow = 202_752;
    const cfg = config([
      "nvidia-glm-5.2",
      "nvidia-deepseek-v4-pro",
      "nvidia-kimi-k2.6",
    ]);
    applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "glm-canary-secret"),
        "deepseek-v4-pro.disabled.json": bundle("nvidia-deepseek-v4-pro", "deepseek-ai/deepseek-v4-pro", "deepseek-canary-secret"),
        "kimi-k2.6.disabled.json": bundle("nvidia-kimi-k2.6", "moonshotai/kimi-k2.6", "kimi-canary-secret"),
      }),
    });

    const rows = buildCatalogEntries(null, [], await gatherRoutedModels(cfg));
    const glm = rows.find(row => row.slug === "nvidia-glm-5.2/z-ai-glm-5.2");
    const deepseek = rows.find(row => row.slug === "nvidia-deepseek-v4-pro/deepseek-ai-deepseek-v4-pro");

    // GLM-5.2 is model-native 1M, but NVIDIA's hosted NIM endpoint has an exact
    // 202,752-token ceiling. Codex must compact with headroom before that ceiling.
    expect(glm?.context_window).toBe(nvidiaEndpointContextWindow);
    expect(glm?.max_context_window).toBe(nvidiaEndpointContextWindow);
    expect(glm?.context_window).not.toBe(modelNativeContextWindow);
    expect(glm?.auto_compact_token_limit).toBe(173_352);
    expect(glm?.auto_compact_token_limit).toBeLessThan(nvidiaEndpointContextWindow);

    // The endpoint override is GLM-only: keep the managed siblings' existing behavior.
    expect(deepseek?.context_window).toBe(128_000);
    expect(rows.some(row => row.slug.startsWith("nvidia-kimi-k2.6/"))).toBe(false);
  });

  test("keeps credentials only in runtime memory and makes Kimi explicitly unroutable", () => {
    const cfg = config([
      "nvidia-glm-5.2",
      "nvidia-deepseek-v4-pro",
      "nvidia-kimi-k2.6",
    ]);
    const statuses = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "glm-canary-secret"),
        "deepseek-v4-pro.disabled.json": bundle("nvidia-deepseek-v4-pro", "deepseek-ai/deepseek-v4-pro", "deepseek-canary-secret"),
        "kimi-k2.6.disabled.json": bundle("nvidia-kimi-k2.6", "moonshotai/kimi-k2.6", "kimi-canary-secret"),
      }),
    });

    expect(statuses.map(item => [item.ref, item.state, item.routingEligible])).toEqual([
      ["nvidia-glm-5.2", "ready", true],
      ["nvidia-deepseek-v4-pro", "ready", true],
      ["nvidia-kimi-k2.6", "configured-unavailable", false],
    ]);
    expect(cfg.providers["nvidia-glm-5.2"]?.disabled).toBeUndefined();
    expect(cfg.providers["nvidia-deepseek-v4-pro"]?.disabled).toBeUndefined();
    expect(cfg.providers["nvidia-kimi-k2.6"]?.disabled).toBe(true);
    expect(cfg.providers["nvidia-kimi-k2.6"]?.externalProviderReason).toBe("upstream-model-not-found");

    const serialized = JSON.stringify(cfg);
    for (const canary of ["glm-canary-secret", "deepseek-canary-secret", "kimi-canary-secret"]) {
      expect(serialized).not.toContain(canary);
    }
    const marker = cfg.providers["nvidia-glm-5.2"]!.apiKey!;
    expect(resolveExternalProviderSecret(marker)).toEqual({ matched: true, value: "glm-canary-secret" });
    expect(resolveEnvValue(marker)).toBe("glm-canary-secret");
    const kimiMarker = cfg.providers["nvidia-kimi-k2.6"]!.apiKey!;
    expect(resolveExternalProviderSecret(kimiMarker)).toEqual({ matched: true, value: undefined });
    expect(resolveEnvValue(kimiMarker)).toBeUndefined();

    const dto = safeConfigDTO(cfg);
    const dtoSerialized = JSON.stringify(dto);
    expect(dtoSerialized).not.toContain("glm-canary-secret");
    expect(dtoSerialized).not.toContain("deepseek-canary-secret");
    expect(dtoSerialized).not.toContain("kimi-canary-secret");
    expect(dto).toMatchObject({
      externalProviderBundles: [
        "nvidia-glm-5.2",
        "nvidia-deepseek-v4-pro",
        "nvidia-kimi-k2.6",
      ],
      providers: {
        "nvidia-glm-5.2": {
          hasApiKey: true,
          externalProviderState: "ready",
        },
        "nvidia-kimi-k2.6": {
          disabled: true,
          externalProviderState: "configured-unavailable",
          externalProviderReason: "upstream-model-not-found",
        },
      },
    });
    expect(routeModel(cfg, "nvidia-glm-5.2/z-ai/glm-5.2")).toMatchObject({
      providerName: "nvidia-glm-5.2",
      modelId: "z-ai/glm-5.2",
    });
    expect(() => routeModel(cfg, "nvidia-kimi-k2.6/moonshotai/kimi-k2.6"))
      .toThrow("Provider is disabled");

    delete cfg.providers["nvidia-kimi-k2.6"]!.disabled;
    expect(() => routeModel(cfg, "nvidia-kimi-k2.6/moonshotai/kimi-k2.6"))
      .toThrow("Managed external provider is unavailable");
  });

  test("rejects allowPrivateNetwork on the fixed public NVIDIA endpoint", () => {
    const cfg = config(["nvidia-glm-5.2"]);
    const [status] = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle(
          "nvidia-glm-5.2",
          "z-ai/glm-5.2",
          "canary",
          { allowPrivateNetwork: true },
        ),
      }),
    });

    expect(status?.state).toBe("bundle-error");
    expect(status?.reason).toBe("unsupported-provider-field");
    expect(cfg.providers["nvidia-glm-5.2"]?.disabled).toBe(true);
    expect(cfg.providers["nvidia-glm-5.2"]?.apiKey).toBeUndefined();
  });

  test("binds a bundle to the exact provider, model, and HTTPS origin", () => {
    const mutations: Array<[string, unknown]> = [
      ["baseUrl", "http://integrate.api.nvidia.com/v1"],
      ["baseUrl", "https://integrate.api.nvidia.com:444/v1"],
      ["baseUrl", "https://user@integrate.api.nvidia.com/v1"],
      ["baseUrl", "https://integrate.api.nvidia.com/v1/"],
      ["baseUrl", "https://example.test/v1"],
      ["adapter", "openai-responses"],
      ["authMode", "local"],
      ["defaultModel", "z-ai/other-model"],
      ["models", ["z-ai/other-model"]],
      ["selectedModels", ["z-ai/other-model"]],
      ["disabled", false],
      ["keyOptional", true],
      ["liveModels", true],
    ];

    for (const [field, value] of mutations) {
      const cfg = config(["nvidia-glm-5.2"]);
      const [status] = applyExternalProviderBundles(cfg, {
        secretRoot: ROOT,
        readFile: reader({
          "glm-5.2.disabled.json": bundle(
            "nvidia-glm-5.2",
            "z-ai/glm-5.2",
            "canary",
            { [field]: value },
          ),
        }),
      });
      expect(status).toMatchObject({
        state: "bundle-error",
        reason: "provider-contract-mismatch",
        routingEligible: false,
      });
      expect(cfg.providers["nvidia-glm-5.2"]?.apiKey).toBeUndefined();
    }

    const wrongProvider = config(["nvidia-glm-5.2"]);
    const [wrongProviderStatus] = applyExternalProviderBundles(wrongProvider, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle(
          "attacker-controlled-id",
          "z-ai/glm-5.2",
          "canary",
        ),
      }),
    });
    expect(wrongProviderStatus).toMatchObject({
      state: "bundle-error",
      reason: "provider-id-mismatch",
    });
  });

  test("managed external fetches reject redirects before a credential can be replayed", async () => {
    const calls: RequestInit[] = [];
    const executor: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      externalProviderRef: "nvidia-glm-5.2",
      fetch: executor,
    } as OcxConfig["providers"][string] & { fetch: typeof fetch };

    await providerFetch(provider)("https://integrate.api.nvidia.com/v1/test", {
      redirect: "follow",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("error");
  });

  test("isolates a missing bundle without disabling a valid sibling", () => {
    const cfg = config(["nvidia-glm-5.2", "nvidia-deepseek-v4-pro"]);
    const statuses = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "canary"),
      }),
    });

    expect(statuses[0]).toMatchObject({ ref: "nvidia-glm-5.2", state: "ready", routingEligible: true });
    expect(statuses[1]).toMatchObject({
      ref: "nvidia-deepseek-v4-pro",
      state: "bundle-error",
      routingEligible: false,
    });
    expect(cfg.providers["nvidia-glm-5.2"]?.disabled).toBeUndefined();
    expect(cfg.providers["nvidia-deepseek-v4-pro"]?.disabled).toBe(true);
  });

  test("does not overwrite an unrelated provider with the same id", () => {
    const cfg = config(["nvidia-glm-5.2"]);
    cfg.providers["nvidia-glm-5.2"] = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "unrelated",
    };
    const [status] = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: () => {
        throw new Error("must-not-read");
      },
    });

    expect(status).toMatchObject({ state: "bundle-error", reason: "provider-id-collision" });
    expect(cfg.providers["nvidia-glm-5.2"]?.baseUrl).toBe("https://example.test/v1");
    expect(() => routeModel(cfg, "nvidia-glm-5.2/z-ai/glm-5.2"))
      .toThrow("Managed external provider bundle collision");
  });

  test("an unresolved external marker never falls through as a literal credential", () => {
    clearExternalProviderSecrets();
    expect(resolveExternalProviderSecret("@opencodex-external/nvidia-glm-5.2")).toEqual({
      matched: true,
      value: undefined,
    });
    expect(resolveEnvValue("@opencodex-external/nvidia-glm-5.2")).toBeUndefined();
    expect(resolveExternalProviderSecret("${NORMAL_ENV}")).toEqual({ matched: false });
  });

  test("diagnostic projection does not replace active runtime credentials", () => {
    const live = config(["nvidia-glm-5.2"]);
    applyExternalProviderBundles(live, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "live-canary"),
      }),
    });

    const diagnostic = config(["nvidia-glm-5.2"]);
    applyExternalProviderBundles(diagnostic, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "diagnostic-canary"),
      }),
      activateSecrets: false,
    });

    expect(resolveExternalProviderSecret(live.providers["nvidia-glm-5.2"]!.apiKey!))
      .toEqual({ matched: true, value: "live-canary" });
  });

  test("rejects oversized bundles before parsing", () => {
    const cfg = config(["nvidia-glm-5.2"]);
    const [status] = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: () => " ".repeat(64 * 1024 + 1),
    });

    expect(status).toMatchObject({ state: "bundle-error", reason: "bundle-too-large" });
    expect(cfg.providers["nvidia-glm-5.2"]?.apiKey).toBeUndefined();
  });

  test("accepts a bundle written with a UTF-8 BOM", () => {
    // On Windows a BOM is the DEFAULT, not an edge case: PowerShell's `>`, `Out-File` and
    // `Set-Content` all emit one, and placing a credential bundle by hand is a PowerShell job.
    // `JSON.parse` rejects U+FEFF, so every bundle on this machine failed closed as
    // `bundle-error: invalid-json` and GLM/DeepSeek could never reach the picker.
    const cfg = config(["nvidia-glm-5.2"]);
    const [status] = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json": `﻿${bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "bom-canary")}`,
      }),
    });

    expect(status).toMatchObject({ ref: "nvidia-glm-5.2", state: "ready", routingEligible: true });
    expect(resolveExternalProviderSecret(cfg.providers["nvidia-glm-5.2"]!.apiKey!))
      .toEqual({ matched: true, value: "bom-canary" });
    // The BOM must not leak into the key itself.
    expect(JSON.stringify(cfg)).not.toContain("bom-canary");
  });

  test("a BOM does not make a malformed bundle parse", () => {
    // Stripping the BOM is an encoding fix only. Everything the contract checks must still
    // fail closed — in particular keyOptional, which is what silently disabled both live
    // bundles on this machine even after the encoding was right.
    const cfg = config(["nvidia-glm-5.2"]);
    const [status] = applyExternalProviderBundles(cfg, {
      secretRoot: ROOT,
      readFile: reader({
        "glm-5.2.disabled.json":
          `﻿${bundle("nvidia-glm-5.2", "z-ai/glm-5.2", "bom-canary", { keyOptional: true })}`,
      }),
    });

    expect(status).toMatchObject({ state: "bundle-error", reason: "provider-contract-mismatch" });
    expect(cfg.providers["nvidia-glm-5.2"]?.apiKey).toBeUndefined();
  });
});
