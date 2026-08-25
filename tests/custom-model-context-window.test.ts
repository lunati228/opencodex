import { describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog/provider-fetch";
import { ensureAutoCompactTokenLimit } from "../src/codex/catalog/parsing";
import { QWEN_PROFILE, LOCAL_RUNTIME_PROVIDER_ID, managedLocalProviderProjection } from "../src/local-runtime/profile";
import { QWEN_CONTEXT_VARIANTS, qwenContextVariantModelId } from "../src/local-runtime/context-tiers";
import type { OcxConfig } from "../src/types";

/**
 * Regression for the reason auto-compaction never fired on a routed model.
 *
 * A custom model row carries no contextWindow of its own, and the old code only ever read
 * `cm.contextWindow`. With nothing set, the catalog entry kept the cloned gpt-5.6 template's
 * 372000 and an auto_compact_token_limit of 334800 — so Codex waited for 334800 tokens on a
 * model whose engine dies at 32768, and the turn hard-errored instead of compacting.
 */
function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      "google-antigravity": {
        adapter: "google",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        authMode: "oauth",
        models: ["gemini-3.7-flash", "claude-sonnet-4-6"],
        modelContextWindows: {
          "gemini-3.7-flash": 1048576,
          "claude-sonnet-4-6": 200000,
        },
      },
    },
    ...overrides,
  } as unknown as OcxConfig;
}

function windowFor(models: Awaited<ReturnType<typeof gatherRoutedModels>>, provider: string, id: string) {
  return models.find(m => m.provider === provider && m.id === id)?.contextWindow;
}

describe("custom model rows inherit their provider's real context window", () => {
  test("a custom row with no contextWindow picks up modelContextWindows", async () => {
    const cfg = config({
      customModels: [
        { id: "a", provider: "google-antigravity", modelId: "claude-sonnet-4-6", displayName: "Antigravity | Claude Sonnet 4.6", addedAt: "2026-07-28T00:00:00.000Z" },
        { id: "b", provider: "google-antigravity", modelId: "gemini-3.7-flash", displayName: "Antigravity | Gemini 3.7 Flash", addedAt: "2026-07-28T00:00:00.000Z" },
      ],
    } as Partial<OcxConfig>);
    const models = await gatherRoutedModels(cfg);
    expect(windowFor(models, "google-antigravity", "claude-sonnet-4-6")).toBe(200000);
    expect(windowFor(models, "google-antigravity", "gemini-3.7-flash")).toBe(1048576);
  });

  // The whole point of the override comment: an operator who typed a number keeps that number.
  test("an explicit contextWindow still wins over the provider map", async () => {
    const cfg = config({
      customModels: [
        { id: "a", provider: "google-antigravity", modelId: "claude-sonnet-4-6", contextWindow: 64000, addedAt: "2026-07-28T00:00:00.000Z" },
      ],
    } as Partial<OcxConfig>);
    const models = await gatherRoutedModels(cfg);
    expect(windowFor(models, "google-antigravity", "claude-sonnet-4-6")).toBe(64000);
  });

  test("a provider with no window information leaves the field unset", async () => {
    const cfg = config({
      providers: {
        ...config().providers,
        bare: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", authMode: "key", models: ["m1"] },
      },
      customModels: [
        { id: "a", provider: "bare", modelId: "m1", addedAt: "2026-07-28T00:00:00.000Z" },
      ],
    } as Partial<OcxConfig>);
    const models = await gatherRoutedModels(cfg);
    expect(windowFor(models, "bare", "m1")).toBeUndefined();
  });

  // Codex has one context/compaction budget per model row. The managed provider therefore
  // publishes one stable model id per fixed Qwen window instead of pretending service_tier can alter model metadata.
  test("the managed local provider reports every fixed Qwen window", async () => {
    const projection = managedLocalProviderProjection(196608);
    const cfg = config({
      providers: { ...config().providers, [LOCAL_RUNTIME_PROVIDER_ID]: projection },
      customModels: [
        { id: "a", provider: LOCAL_RUNTIME_PROVIDER_ID, modelId: QWEN_PROFILE.modelId, displayName: "Local | Huihui Qwen3.8", addedAt: "2026-07-28T00:00:00.000Z" },
      ],
    } as Partial<OcxConfig>);
    const models = await gatherRoutedModels(cfg);
    for (const variant of QWEN_CONTEXT_VARIANTS) {
      const modelId = qwenContextVariantModelId(QWEN_PROFILE.modelId, variant.contextWindow);
      expect(windowFor(models, LOCAL_RUNTIME_PROVIDER_ID, modelId)).toBe(variant.contextWindow);
    }
  });
});

describe("auto-compaction reproduces native Codex, at every window size", () => {
  // Not a hardcoded threshold: always derived from whatever window the entry carries, which is
  // why fixing the window above is what actually fixes compaction.
  //
  // The fraction is 0.855, not 0.9, and that is measured rather than chosen — see
  // AUTO_COMPACT_WINDOW_FRACTION. Codex reserves 5% of the catalog window and then fires at ~90%
  // of the remainder, so 0.95 * 0.90 = 0.855 puts routed models on native's trigger point.
  test.each([
    [32768, 28016],
    [65536, 56033],
    [200000, 171000],
    [1048576, 896532],
  ])("context_window %i compacts at %i", (contextWindow, expected) => {
    expect(ensureAutoCompactTokenLimit({ context_window: contextWindow }).auto_compact_token_limit).toBe(expected);
  });

  // The guard against drifting back to a flat 0.9: that would sit at ~94.7% of the window Codex
  // actually works with, i.e. later than native, which is how sol was observed compacting at
  // 100.7% of its reported window (already overflowed).
  test.each([372000, 272000, 65536])("the limit lands near 90%% of Codex's reported window (%i)", catalogWindow => {
    const limit = ensureAutoCompactTokenLimit({ context_window: catalogWindow }).auto_compact_token_limit as number;
    const reported = catalogWindow * 0.95;
    expect(limit / reported).toBeCloseTo(0.9, 3);
  });

  test("an entry that already states its own limit is left alone", () => {
    const entry = ensureAutoCompactTokenLimit({ context_window: 65536, auto_compact_token_limit: 40000 });
    expect(entry.auto_compact_token_limit).toBe(40000);
  });

  test("no window means no invented limit", () => {
    expect(ensureAutoCompactTokenLimit({}).auto_compact_token_limit).toBeUndefined();
  });
});
