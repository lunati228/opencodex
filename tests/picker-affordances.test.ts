import { describe, expect, test } from "bun:test";
import {
  QUOTA_SUFFIX_SEPARATOR,
  formatQuotaSuffix,
  quotaSuffixForProvider,
  withQuotaSuffix,
} from "../src/codex/catalog/quota-suffix";
import {
  QWEN_CONTEXT_VARIANTS,
  qwenContextVariantForModelId,
  qwenContextVariantModelId,
} from "../src/local-runtime/context-tiers";
import { QWEN_PROFILE } from "../src/local-runtime/profile";
import {
  applyExternalAutoReviewCatalogPolicy,
  applyPickerAffordances,
} from "../src/codex/catalog/sync";
import { EXTERNAL_AUTO_REVIEW_SLUG } from "../src/codex/helper-turn-models";
import type { OcxConfig } from "../src/types";
import type { ProviderQuotaResponse } from "../src/providers/quota";

describe("quota suffix — percent is USED, so the suffix shows what is left", () => {
  test("subtracts from 100", () => {
    // Confirmed twice: the dashboard renders percent 0 as "0% used", and OpenAI reported
    // monthlyPercent 100 on an account whose quota really was exhausted.
    expect(formatQuotaSuffix({ weeklyPercent: 28, updatedAt: 0 })).toBe("weekly 72% left");
    expect(formatQuotaSuffix({ monthlyPercent: 100, updatedAt: 0 })).toBe("monthly 0% left");
  });

  test("renders Antigravity's per-family custom windows", () => {
    expect(formatQuotaSuffix({
      updatedAt: 0,
      customWindows: [
        { label: "Gem", percent: 0, resetAt: 1 },
        { label: "Cla", percent: 40, resetAt: 1 },
      ],
    })).toBe("Gem 100% left · Cla 60% left");
  });

  test("clamps an overage instead of printing a negative", () => {
    expect(formatQuotaSuffix({ weeklyPercent: 130, updatedAt: 0 })).toBe("weekly 0% left");
  });

  // A local engine or a flat-rate key has no quota concept; it must read exactly as before.
  test("returns empty when there is nothing usable to show", () => {
    expect(formatQuotaSuffix(undefined)).toBe("");
    expect(formatQuotaSuffix({ updatedAt: 0 })).toBe("");
    expect(formatQuotaSuffix({ updatedAt: 0, customWindows: [] })).toBe("");
  });

  test("a cold cache yields no suffix rather than a placeholder", () => {
    expect(quotaSuffixForProvider(null, "google-antigravity")).toBe("");
  });

  test("picks the matching provider out of a full report", () => {
    const reports: ProviderQuotaResponse = {
      generatedAt: 0,
      reports: [
        { provider: "openai", label: "OpenAI", source: "s", updatedAt: 0, quota: { weeklyPercent: 10, updatedAt: 0 } },
        { provider: "google-antigravity", label: "AGY", source: "s", updatedAt: 0, quota: { updatedAt: 0, customWindows: [{ label: "Gem", percent: 25, resetAt: 1 }] } },
      ],
    };
    expect(quotaSuffixForProvider(reports, "google-antigravity")).toBe("Gem 75% left");
    expect(quotaSuffixForProvider(reports, "not-configured")).toBe("");
  });
});

describe("quota suffix — never accumulates across catalog builds", () => {
  test("a second build replaces the first suffix", () => {
    const once = withQuotaSuffix("Balanced model.", "weekly 90% left");
    const twice = withQuotaSuffix(once, "weekly 40% left");
    expect(twice).toBe(`Balanced model.${QUOTA_SUFFIX_SEPARATOR}weekly 40% left`);
    expect(twice.split(QUOTA_SUFFIX_SEPARATOR)).toHaveLength(2);
  });

  test("an empty suffix strips a stale one instead of leaving it behind", () => {
    const stale = withQuotaSuffix("Balanced model.", "weekly 90% left");
    expect(withQuotaSuffix(stale, "")).toBe("Balanced model.");
  });
});

describe("Qwen context catalog variants", () => {
  test("pins exactly the two accepted context and compaction pairs", () => {
    // Trimmed from six to two on 2026-07-29: six local rows dominated the
    // picker, and Codex's Speed control cannot carry a context window, so
    // fewer rows is the only honest way to shorten the list.
    expect(QWEN_CONTEXT_VARIANTS).toEqual([
      { label: "128K", contextWindow: 131_072, autoCompactTokenLimit: 112_066 },
      { label: "192K", contextWindow: 196_608, autoCompactTokenLimit: 168_099 },
    ]);
  });

  test("keeps the accepted 192K model id bare and suffixes the lower-memory row", () => {
    expect(QWEN_CONTEXT_VARIANTS.map(variant =>
      qwenContextVariantModelId(QWEN_PROFILE.modelId, variant.contextWindow),
    )).toEqual([
      `${QWEN_PROFILE.modelId}[128K]`,
      QWEN_PROFILE.modelId,
    ]);
  });

  test("every retired suffix resolves to nothing rather than a different allocation", () => {
    // 16K/32K/64K/256K were real rows before the trim, and [8K]/[24K]/[48K]/[96K]
    // before that. A stale id must never quietly select a window llama.cpp is not
    // running: strict matching is the whole point.
    for (const label of ["8K", "16K", "24K", "32K", "48K", "64K", "96K", "192K", "256K"]) {
      expect(qwenContextVariantForModelId(`${QWEN_PROFILE.modelId}[${label}]`, QWEN_PROFILE.modelId))
        .toBeUndefined();
    }
  });

  test("resolves both bare and namespaced model ids without reading service_tier", () => {
    expect(qwenContextVariantForModelId(QWEN_PROFILE.modelId, QWEN_PROFILE.modelId)?.contextWindow)
      .toBe(196_608);
    expect(qwenContextVariantForModelId(
      `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}[128K]`,
      QWEN_PROFILE.modelId,
    )?.contextWindow).toBe(131_072);
  });
});

describe("applyPickerAffordances", () => {
  test("pins each Qwen row's label, context, and compaction threshold and removes speed tiers", () => {
    const entry: Record<string, unknown> = {
      slug: `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}[128K]`,
      description: "Local model.",
      service_tiers: [{ id: "ctx-8192" }],
      default_service_tier: "ctx-8192",
    };
    applyPickerAffordances(entry, QWEN_PROFILE.providerId);
    expect(entry.display_name).toBe("Local | Qwen 3.8 27B · 128K");
    expect(entry.context_window).toBe(131_072);
    expect(entry.max_context_window).toBe(131_072);
    expect(entry.auto_compact_token_limit).toBe(112_066);
    expect(entry.service_tiers).toBeUndefined();
    expect(entry.default_service_tier).toBeUndefined();
  });

  test("uses the explicit 192K name for the accepted default row", () => {
    const entry: Record<string, unknown> = {
      slug: `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}`,
      description: "Local model.",
    };
    applyPickerAffordances(entry, QWEN_PROFILE.providerId);
    expect(entry.display_name).toBe("Local | Qwen 3.8 27B · 192K");
    expect(entry.context_window).toBe(196_608);
    expect(entry.auto_compact_token_limit).toBe(168_099);
  });

  test("leaves a non-local routed provider's speed row alone", () => {
    const entry: Record<string, unknown> = { description: "Some model.", service_tiers: [{ id: "priority" }] };
    applyPickerAffordances(entry, "google-antigravity");
    expect(entry.service_tiers).toEqual([{ id: "priority" }]);
  });

  test("an empty provider id is a no-op rather than a crash", () => {
    const entry: Record<string, unknown> = { description: "Some model." };
    applyPickerAffordances(entry, "");
    expect(entry.description).toBe("Some model.");
  });
});

describe("external-only auto-review catalog policy", () => {
  test("annotates routed rows but never native rows or the usage readout", () => {
    const native: Record<string, unknown> = { slug: "gpt-5.6-sol" };
    const routed: Record<string, unknown> = { slug: "google-antigravity/gemini-3.7-flash" };
    const usage: Record<string, unknown> = { slug: "agy-cli/usage" };
    const config = {
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "external",
    } as OcxConfig;

    applyExternalAutoReviewCatalogPolicy(
      [native, routed, usage],
      new Set(["google-antigravity/gemini-3.7-flash"]),
      config,
    );

    expect(native.auto_review_model_override).toBeUndefined();
    expect(routed.auto_review_model_override).toBe(EXTERNAL_AUTO_REVIEW_SLUG);
    expect(usage.auto_review_model_override).toBeUndefined();
  });

  test("does nothing in global compatibility mode", () => {
    const routed: Record<string, unknown> = { slug: "google-antigravity/gemini-3.7-flash" };
    applyExternalAutoReviewCatalogPolicy(
      [routed],
      new Set(["google-antigravity/gemini-3.7-flash"]),
      { autoReviewModel: "google-antigravity/gemini-3.7-flash" } as OcxConfig,
    );
    expect(routed.auto_review_model_override).toBeUndefined();
  });

  test("threshold mode keeps the external-origin alias even when legacy scope is all", () => {
    const routed: Record<string, unknown> = { slug: "google-antigravity/gemini-3.7-flash" };
    applyExternalAutoReviewCatalogPolicy(
      [routed],
      new Set(["google-antigravity/gemini-3.7-flash"]),
      {
        autoReviewModel: "google-antigravity/gemini-3.7-flash",
        helperTurnScope: "all",
        helperTurnCodexRemainingPercentThreshold: 5,
      } as OcxConfig,
    );
    expect(routed.auto_review_model_override).toBe(EXTERNAL_AUTO_REVIEW_SLUG);
  });
});
