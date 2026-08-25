import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decorateCatalogQuotaRows,
  primeCatalogQuotaDecoration,
  refreshCatalogQuotaDecoration,
} from "../src/codex/catalog/quota-decoration";
import {
  AGY_BRIDGE_ROW_SLUG,
  AGY_PROVIDER_USAGE_ROW_SLUG,
} from "../src/codex/catalog/agy-bridge-row";
import type { RawEntry } from "../src/codex/catalog/parsing";
import type { ProviderQuotaResponse } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";
import { qwenContextVariantModelId } from "../src/local-runtime/context-tiers";
import { QWEN_PROFILE } from "../src/local-runtime/profile";

const reports: ProviderQuotaResponse = {
  generatedAt: 1,
  reports: [
    {
      provider: "openai",
      label: "OpenAI",
      source: "test",
      updatedAt: 1,
      quota: { weeklyPercent: 28, updatedAt: 1 },
    },
    {
      provider: "google-antigravity",
      label: "Antigravity",
      source: "test",
      updatedAt: 1,
      quota: {
        updatedAt: 1,
        customWindows: [
          { label: "Gemini · 5h", percent: 25, resetAt: 2 },
          { label: "Gemini · weekly", percent: 40, resetAt: 2 },
          { label: "Claude · 5h", percent: 20, resetAt: 2 },
          { label: "Claude · weekly", percent: 10, resetAt: 2 },
        ],
      },
    },
  ],
};

describe("safe catalog quota decoration", () => {
  test("updates routable provider rows without changing catalog membership", () => {
    const models: RawEntry[] = [
      { slug: "gpt-5.6-sol", display_name: "5.6 Sol", description: "Native." },
      {
        slug: "google-antigravity/gemini-3.7-flash",
        display_name: "Antigravity | Gemini 3.7 Flash",
        description: "Routed model.",
      },
      { slug: AGY_PROVIDER_USAGE_ROW_SLUG, display_name: "old AGY", description: "old" },
      { slug: AGY_BRIDGE_ROW_SLUG, display_name: "old MCP", description: "old" },
    ];
    const before = models.map(model => model.slug);

    const changed = decorateCatalogQuotaRows(models, reports);

    expect(changed).toBe(1);
    expect(models.map(model => model.slug)).toEqual(before);
    expect(models[0]).toEqual({
      slug: "gpt-5.6-sol",
      display_name: "5.6 Sol",
      description: "Native.",
    });
    expect(models[1]!.description).toContain("Gemini · 5h 75% left");
    expect(models[1]!.description).toContain("Gemini · weekly 60% left");
    expect(models[1]!.description).toContain("Claude · 5h 80% left");
    expect(models[1]!.description).toContain("Claude · weekly 90% left");
    // Legacy display rows are removed by catalog sync, not quota decoration;
    // this metadata-only pass must never recreate or mutate them.
    expect(models[2]).toEqual({
      slug: AGY_PROVIDER_USAGE_ROW_SLUG,
      display_name: "old AGY",
      description: "old",
    });
    expect(models[3]).toEqual({
      slug: AGY_BRIDGE_ROW_SLUG,
      display_name: "old MCP",
      description: "old",
    });
  });
});

describe("startup quota priming", () => {
  const config = { port: 10100, providers: {}, defaultProvider: "openai" } as unknown as OcxConfig;

  test("a failed prime is swallowed so a cold quota endpoint cannot affect startup", async () => {
    const result = await primeCatalogQuotaDecoration(config, async () => {
      throw new Error("network blocked");
    });
    expect(result).toBeNull();
  });

  test("prime passes the fetched reports straight into the metadata-only decoration", async () => {
    let received: ProviderQuotaResponse | null = null;
    const result = await primeCatalogQuotaDecoration(config, async () => {
      received = reports;
      return reports;
    });
    // No catalog file exists in the test root, so the decoration is a safe no-op;
    // what matters is that the prime resolved and fed it the fresh reports.
    expect(received).toBe(reports);
    expect(result).not.toBeNull();
    expect(result?.written).toBe(false);
  });
});

describe("persisted picker-row cleanup during quota decoration", () => {
  test("does not restore retired usage rows or the legacy Qwen repository label", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-quota-picker-"));
    const qwen128k = qwenContextVariantModelId(QWEN_PROFILE.modelId, 131_072);
    try {
      process.env.CODEX_HOME = codexHome;
      writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
        models: [
          { slug: AGY_PROVIDER_USAGE_ROW_SLUG, display_name: "AGY Usage | Not read", description: "old" },
          { slug: AGY_BRIDGE_ROW_SLUG, display_name: "MCP Usage | not read", description: "old" },
          {
            slug: `${QWEN_PROFILE.providerId}/${qwen128k}`,
            display_name: "Huihui-Qwen3.8-27B-abliterated-Q6_K_L · 128K",
            description: "Local model.",
          },
        ],
      }, null, 2) + "\n");

      const refreshed = refreshCatalogQuotaDecoration(reports);
      const models = (JSON.parse(readFileSync(join(codexHome, "opencodex-catalog.json"), "utf8")) as {
        models: Array<{ slug: string; display_name?: string }>;
      }).models;

      expect(refreshed.written).toBe(true);
      expect(models.map(model => model.slug)).not.toContain(AGY_PROVIDER_USAGE_ROW_SLUG);
      expect(models.map(model => model.slug)).not.toContain(AGY_BRIDGE_ROW_SLUG);
      expect(models[0]).toMatchObject({
        slug: `${QWEN_PROFILE.providerId}/${qwen128k}`,
        display_name: "Local | Qwen 3.8 27B · 128K",
      });
      expect(refreshCatalogQuotaDecoration(reports).written).toBe(false);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
