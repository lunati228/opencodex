import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import {
  CODEX_AUTO_REVIEW_SLUG,
  EXTERNAL_AUTO_REVIEW_SLUG,
  activeAutoCompactModelOverrideForTurn,
  activeAutoReviewModelOverrideForTurn,
  autoCompactModelOverride,
  autoReviewModelOverride,
  autoReviewTurnModelId,
  compactionTurnModelId,
  helperTurnQuotaOverrideActive,
  helperTurnReasoningEffort,
  helperTurnScope,
  type HelperTurnQuotaContext,
} from "../src/codex/helper-turn-models";
import { CODEX_CAPACITY_MAX_QUOTA_AGE_MS } from "../src/providers/codex-capacity";
import { ANTIGRAVITY_MODEL_EFFORTS } from "../src/providers/antigravity-models";
import type { ProviderQuota, ProviderQuotaResponse } from "../src/providers/quota";
import { routeModel, routeModelForPolicy } from "../src/router";
import { handleManagementAPI } from "../src/server/management-api";
import { validateConfigCandidate } from "../src/config";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { QWEN_PROFILE, managedLocalProviderProjection } from "../src/local-runtime/profile";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

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
        models: ["gemini-3.7-flash"],
      },
    },
    ...overrides,
  } as unknown as OcxConfig;
}

const QUOTA_NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

function quotaContext(
  quota: Omit<Partial<ProviderQuota>, "updatedAt"> | null,
  ageMs = 0,
  provider = "openai",
): HelperTurnQuotaContext {
  if (!quota) return { reports: null, now: QUOTA_NOW };
  const updatedAt = QUOTA_NOW - ageMs;
  const reports: ProviderQuotaResponse = {
    generatedAt: QUOTA_NOW,
    reports: [{
      provider,
      label: "OpenAI Codex",
      source: "test",
      quota: { ...quota, updatedAt },
      updatedAt,
    }],
  };
  return { reports, now: QUOTA_NOW };
}

describe("auto-review redirect", () => {
  // Codex ships codex-auto-review as a hidden catalog slug and sends it on the wire. It is not
  // in the gpt-/o1-/o3-/o4- family, so every routing rule missed it and it landed on
  // defaultProvider — a review on OpenAI while the conversation ran somewhere else entirely.
  test("without an override it still lands on the default provider", () => {
    expect(routeModel(config(), CODEX_AUTO_REVIEW_SLUG).providerName).toBe("openai");
  });

  test("an override sends the review to the chosen provider", () => {
    const route = routeModel(
      config({ autoReviewModel: "google-antigravity/gemini-3.7-flash" }),
      CODEX_AUTO_REVIEW_SLUG,
    );
    expect(route.providerName).toBe("google-antigravity");
    expect(route.modelId).toBe("gemini-3.7-flash");
  });

  test("a saved 3.6 AGY reviewer migrates to the live 3.7 tiered wire request", async () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.6-flash",
      helperTurnReasoningEffort: "high",
    });
    const route = routeModel(cfg, CODEX_AUTO_REVIEW_SLUG);
    expect(route).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.6-flash",
    });

    const provider = {
      ...cfg.providers["google-antigravity"],
      googleMode: "cloud-code-assist",
      project: "helper-compat-project",
      apiKey: "helper-compat-token",
      modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
    } as OcxConfig["providers"][string];
    const request = await createGoogleAdapter(provider).buildRequest({
      modelId: route.modelId,
      stream: false,
      context: { messages: [{ role: "user", content: "review" }], systemPrompt: [], tools: [] },
      options: { reasoning: helperTurnReasoningEffort(cfg) },
    } as unknown as OcxParsedRequest);
    const envelope = JSON.parse(request.body);
    expect(envelope.model).toBe("gemini-3.7-flash-tiered");
    expect(envelope.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("external-only scope leaves native review untouched and routes only the external alias", () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "external",
      helperTurnReasoningEffort: "high",
    });
    expect(autoReviewTurnModelId(cfg, CODEX_AUTO_REVIEW_SLUG)).toBe(CODEX_AUTO_REVIEW_SLUG);
    expect(routeModel(cfg, CODEX_AUTO_REVIEW_SLUG).providerName).toBe("openai");
    expect(autoReviewTurnModelId(cfg, EXTERNAL_AUTO_REVIEW_SLUG))
      .toBe("google-antigravity/gemini-3.7-flash");
    expect(routeModel(cfg, EXTERNAL_AUTO_REVIEW_SLUG)).toMatchObject({
      providerName: "google-antigravity",
      modelId: "gemini-3.7-flash",
    });
    expect(helperTurnScope(cfg)).toBe("external");
    expect(helperTurnReasoningEffort(cfg)).toBe("high");
  });

  test("external review always uses the configured available Gemini while native review switches at 5% remaining", () => {
    const helperModel = "google-antigravity/gemini-3.6-flash";
    const cfg = config({
      autoReviewModel: helperModel,
      helperTurnScope: "external",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    const sixPercentLeft = quotaContext({ weeklyPercent: 94 });
    expect(helperTurnQuotaOverrideActive(cfg, sixPercentLeft)).toBe(false);
    expect(autoReviewTurnModelId(cfg, EXTERNAL_AUTO_REVIEW_SLUG, sixPercentLeft))
      .toBe(helperModel);
    expect(autoReviewTurnModelId(cfg, CODEX_AUTO_REVIEW_SLUG, sixPercentLeft))
      .toBe(CODEX_AUTO_REVIEW_SLUG);
    expect(activeAutoReviewModelOverrideForTurn(cfg, EXTERNAL_AUTO_REVIEW_SLUG, sixPercentLeft))
      .toBe(helperModel);
    expect(routeModel(cfg, EXTERNAL_AUTO_REVIEW_SLUG, undefined, sixPercentLeft))
      .toMatchObject({ providerName: "google-antigravity", modelId: "gemini-3.6-flash" });

    const fivePercentLeft = quotaContext({ weeklyPercent: 95 });
    expect(helperTurnQuotaOverrideActive(cfg, fivePercentLeft)).toBe(true);
    expect(autoReviewTurnModelId(cfg, EXTERNAL_AUTO_REVIEW_SLUG, fivePercentLeft))
      .toBe(helperModel);
    expect(autoReviewTurnModelId(cfg, CODEX_AUTO_REVIEW_SLUG, fivePercentLeft))
      .toBe(helperModel);
    expect(activeAutoReviewModelOverrideForTurn(cfg, CODEX_AUTO_REVIEW_SLUG, fivePercentLeft))
      .toBe(helperModel);
    expect(routeModel(cfg, EXTERNAL_AUTO_REVIEW_SLUG, undefined, fivePercentLeft))
      .toMatchObject({ providerName: "google-antigravity", modelId: "gemini-3.6-flash" });
  });

  test("the quota gate uses the most constrained known window", () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    expect(helperTurnQuotaOverrideActive(cfg, quotaContext({
      fiveHourPercent: 10,
      weeklyPercent: 30,
      monthlyPercent: 40,
      customWindows: [{ label: "shared", percent: 96 }],
    }))).toBe(true);
  });

  test("unknown, stale, and malformed quota keep native review native but not external review", () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "external",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    const stale = quotaContext({ weeklyPercent: 100 }, CODEX_CAPACITY_MAX_QUOTA_AGE_MS);
    const barelyFresh = quotaContext(
      { weeklyPercent: 100 },
      CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1,
    );
    expect(helperTurnQuotaOverrideActive(cfg, barelyFresh)).toBe(true);
    for (const context of [quotaContext(null), stale]) {
      expect(helperTurnQuotaOverrideActive(cfg, context)).toBe(false);
      expect(autoReviewTurnModelId(cfg, EXTERNAL_AUTO_REVIEW_SLUG, context))
        .toBe("google-antigravity/gemini-3.7-flash");
      expect(autoReviewTurnModelId(cfg, CODEX_AUTO_REVIEW_SLUG, context))
        .toBe(CODEX_AUTO_REVIEW_SLUG);
    }

    const malformed = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "external",
      helperTurnCodexRemainingPercentThreshold: "5" as unknown as number,
    });
    expect(helperTurnQuotaOverrideActive(malformed, quotaContext({ weeklyPercent: 100 }))).toBe(false);
    expect(autoReviewTurnModelId(malformed, EXTERNAL_AUTO_REVIEW_SLUG, quotaContext({ weeklyPercent: 100 })))
      .toBe("google-antigravity/gemini-3.7-flash");
    expect(autoReviewTurnModelId(malformed, CODEX_AUTO_REVIEW_SLUG, quotaContext({ weeklyPercent: 100 })))
      .toBe(CODEX_AUTO_REVIEW_SLUG);
  });

  test("a malformed hand-edited threshold survives loading as a fail-native marker", () => {
    const parsed = validateConfigCandidate(config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnCodexRemainingPercentThreshold: "5" as unknown as number,
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(helperTurnQuotaOverrideActive(
      parsed.config,
      quotaContext({ weeklyPercent: 100 }),
    )).toBe(false);
  });

  test("near-boundary, windowless, and non-Codex quota reports do not activate Gemini", () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    expect(helperTurnQuotaOverrideActive(cfg, quotaContext({ weeklyPercent: 94.999 }))).toBe(false);
    expect(helperTurnQuotaOverrideActive(cfg, quotaContext({}))).toBe(false);
    expect(helperTurnQuotaOverrideActive(
      cfg,
      quotaContext({ weeklyPercent: 100 }, 0, "google-antigravity"),
    )).toBe(false);
  });

  test("out-of-range quota percentages are malformed, not silently clamped", () => {
    const cfg = config({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    expect(helperTurnQuotaOverrideActive(cfg, quotaContext({ weeklyPercent: 101 }))).toBe(false);
    expect(helperTurnQuotaOverrideActive(cfg, quotaContext({ weeklyPercent: -1 }))).toBe(false);
  });

  test("the override does not touch any other model", () => {
    const cfg = config({ autoReviewModel: "google-antigravity/gemini-3.7-flash" });
    expect(routeModel(cfg, "gpt-5.6-sol").providerName).toBe("openai");
  });

  test("a self-referencing override is ignored rather than recursed", () => {
    const cfg = config({ autoReviewModel: CODEX_AUTO_REVIEW_SLUG });
    expect(autoReviewModelOverride(cfg)).toBeUndefined();
    expect(routeModel(cfg, CODEX_AUTO_REVIEW_SLUG).providerName).toBe("openai");
  });

  test.each([undefined, "", "   "])("a blank override (%p) is no override", value => {
    expect(autoReviewModelOverride(config({ autoReviewModel: value } as Partial<OcxConfig>))).toBeUndefined();
  });
});

describe("auto-compaction redirect", () => {
  // Compaction has no slug of its own — it rides the conversation's model with a
  // compaction_trigger item — so the marker is the only thing that can select it.
  test("only a compaction turn is redirected", () => {
    const cfg = config({ autoCompactModel: "google-antigravity/gemini-3.7-flash" });
    expect(compactionTurnModelId(cfg, "gpt-5.6-sol", true)).toBe("google-antigravity/gemini-3.7-flash");
    expect(compactionTurnModelId(cfg, "gpt-5.6-sol", false)).toBe("gpt-5.6-sol");
  });

  test("external-only scope redirects an external source but preserves a native source", () => {
    const cfg = config({
      autoCompactModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "external",
    });
    expect(compactionTurnModelId(cfg, "gpt-5.6-sol", true, false)).toBe("gpt-5.6-sol");
    expect(compactionTurnModelId(
      cfg,
      "google-antigravity/claude-sonnet-4-6",
      true,
      true,
    )).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("threshold mode always sends external compaction to Gemini and never redirects native compaction", () => {
    const helperModel = "google-antigravity/gemini-3.6-flash";
    const cfg = config({
      autoCompactModel: helperModel,
      helperTurnScope: "external",
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    const external = "qwen-local/huihui-qwen3.8-27b-abliterated-q6-k-l";
    expect(compactionTurnModelId(cfg, external, true, true, quotaContext({ weeklyPercent: 94 })))
      .toBe(helperModel);
    expect(compactionTurnModelId(cfg, external, true, true, quotaContext({ weeklyPercent: 95 })))
      .toBe(helperModel);
    expect(compactionTurnModelId(cfg, external, true, true, quotaContext(null)))
      .toBe(helperModel);
    expect(compactionTurnModelId(
      cfg,
      external,
      true,
      true,
      quotaContext({ weeklyPercent: 100 }, CODEX_CAPACITY_MAX_QUOTA_AGE_MS),
    )).toBe(helperModel);
    expect(compactionTurnModelId(cfg, "gpt-5.6-sol", true, false, quotaContext({ weeklyPercent: 100 })))
      .toBe("gpt-5.6-sol");

    const malformed = config({
      autoCompactModel: "google-antigravity/gemini-3.7-flash",
      helperTurnScope: "all",
      helperTurnCodexRemainingPercentThreshold: 5.5,
    });
    expect(compactionTurnModelId(
      malformed,
      external,
      true,
      true,
      quotaContext({ weeklyPercent: 100 }),
    )).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("an active compaction override is recorded even when it names the current model", () => {
    const model = "google-antigravity/gemini-3.7-flash";
    const cfg = config({
      autoCompactModel: model,
      helperTurnCodexRemainingPercentThreshold: 5,
    });
    expect(activeAutoCompactModelOverrideForTurn(
      cfg,
      true,
      true,
      quotaContext({ weeklyPercent: 94.999 }),
    )).toBe(model);
    expect(activeAutoCompactModelOverrideForTurn(
      cfg,
      true,
      true,
      quotaContext({ weeklyPercent: 95 }),
    )).toBe(model);
  });

  test("without an override compaction stays on the conversation model", () => {
    expect(compactionTurnModelId(config(), "gpt-5.6-sol", true)).toBe("gpt-5.6-sol");
    expect(autoCompactModelOverride(config())).toBeUndefined();
  });

  test("policy routing classifies a stopped local runtime without trying to start it", () => {
    const cfg = config();
    cfg.providers[QWEN_PROFILE.providerId] = managedLocalProviderProjection(184_320);
    expect(() => routeModel(
      cfg,
      `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}`,
    )).toThrow("Managed local runtime is not ready");
    expect(routeModelForPolicy(
      cfg,
      `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}`,
    )).toMatchObject({ providerName: QWEN_PROFILE.providerId, modelId: QWEN_PROFILE.modelId });
  });
});

async function put(body: unknown, cfg: OcxConfig): Promise<Response> {
  const req = new Request("http://localhost/api/helper-turn-models", {
    method: "PUT",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, {
    saveConfigPreservingClaudeCode: () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("helper-turn model management route", () => {
  test("reports both settings", async () => {
    const req = new Request("http://localhost/api/helper-turn-models", {
      headers: { host: "localhost" },
    });
    const response = await handleManagementAPI(req, new URL(req.url), config(), {});
    expect(await response!.json()).toEqual({
      autoReviewModel: null,
      autoCompactModel: null,
      helperTurnScope: "all",
      helperTurnReasoningEffort: null,
      helperTurnCodexRemainingPercentThreshold: null,
    });
  });

  test("stores a routable target", async () => {
    const cfg = config();
    const response = await put({ autoReviewModel: "google-antigravity/gemini-3.7-flash" }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.autoReviewModel).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("stores a target qualified by a case-insensitive provider alias", async () => {
    const cfg = config();
    cfg.providers["google-antigravity"].alias = "agy";
    const response = await put({ autoReviewModel: "AGY/gemini-3.7-flash" }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.autoReviewModel).toBe("AGY/gemini-3.7-flash");
  });

  test("refuses an ambiguous case-insensitive provider alias", async () => {
    const cfg = config();
    cfg.providers.openai.alias = "shared";
    cfg.providers["google-antigravity"].alias = "SHARED";
    const response = await put({ autoReviewModel: "shared/gemini-3.7-flash" }, cfg);
    expect(response.status).toBe(422);
    expect(cfg.autoReviewModel).toBeUndefined();
  });

  test("null clears an override", async () => {
    const cfg = config({ autoReviewModel: "google-antigravity/gemini-3.7-flash" });
    const response = await put({ autoReviewModel: null }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.autoReviewModel).toBeUndefined();
  });

  // A helper turn fires unattended, so a typo must not wait until mid-conversation to surface.
  // routeModel alone cannot catch this: an unrecognised id falls through to defaultProvider and
  // "routes" successfully, so the namespace prefix is checked explicitly.
  test("a target naming no configured provider is refused", async () => {
    const cfg = config();
    const response = await put({ autoReviewModel: "nope/not-a-model" }, cfg);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("no configured provider");
    expect(cfg.autoReviewModel).toBeUndefined();
  });

  test("a disabled provider is refused too", async () => {
    const cfg = config();
    (cfg.providers["google-antigravity"] as { disabled?: boolean }).disabled = true;
    const response = await put({ autoReviewModel: "google-antigravity/gemini-3.7-flash" }, cfg);
    expect(response.status).toBe(422);
    expect(cfg.autoReviewModel).toBeUndefined();
  });

  // ChatGPT-forward compaction returns an OpenAI-encrypted blob that decodes to nothing for any
  // routed model, so accepting it would silently discard the history it was meant to preserve.
  test("compaction may not be pointed at the ChatGPT-forward provider", async () => {
    const cfg = config();
    const response = await put({ autoCompactModel: "gpt-5.6-sol" }, cfg);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("unreadable");
    expect(cfg.autoCompactModel).toBeUndefined();
  });

  test("but a routed compaction target is accepted", async () => {
    const cfg = config();
    const response = await put({ autoCompactModel: "google-antigravity/gemini-3.7-flash" }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.autoCompactModel).toBe("google-antigravity/gemini-3.7-flash");
  });

  test("stores external-only scope and the literal high effort", async () => {
    const cfg = config();
    const response = await put({
      helperTurnScope: "external",
      helperTurnReasoningEffort: "high",
    }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.helperTurnScope).toBe("external");
    expect(cfg.helperTurnReasoningEffort).toBe("high");
    expect(await response.json()).toMatchObject({
      helperTurnScope: "external",
      helperTurnReasoningEffort: "high",
    });
  });

  test("stores and clears the Codex remaining-percent threshold", async () => {
    const cfg = config();
    const stored = await put({ helperTurnCodexRemainingPercentThreshold: 5 }, cfg);
    expect(stored.status).toBe(200);
    expect(cfg.helperTurnCodexRemainingPercentThreshold).toBe(5);
    expect(await stored.json()).toMatchObject({ helperTurnCodexRemainingPercentThreshold: 5 });

    const cleared = await put({ helperTurnCodexRemainingPercentThreshold: null }, cfg);
    expect(cleared.status).toBe(200);
    expect(cfg.helperTurnCodexRemainingPercentThreshold).toBeUndefined();
  });

  test.each([0, 100])("accepts the inclusive threshold boundary %i", async threshold => {
    const cfg = config();
    const response = await put({ helperTurnCodexRemainingPercentThreshold: threshold }, cfg);
    expect(response.status).toBe(200);
    expect(cfg.helperTurnCodexRemainingPercentThreshold).toBe(threshold);
  });

  test.each([
    ["unknown field", { autoReviewModel: "gpt-5.6-sol", nope: 1 }],
    ["empty string", { autoReviewModel: "   " }],
    ["wrong type", { autoCompactModel: 42 }],
    ["bad scope", { helperTurnScope: "native" }],
    ["bad effort", { helperTurnReasoningEffort: "maximum" }],
    ["negative threshold", { helperTurnCodexRemainingPercentThreshold: -1 }],
    ["fractional threshold", { helperTurnCodexRemainingPercentThreshold: 5.5 }],
    ["string threshold", { helperTurnCodexRemainingPercentThreshold: "5" }],
    ["oversized threshold", { helperTurnCodexRemainingPercentThreshold: 101 }],
  ])("rejects %s", async (_label, body) => {
    const cfg = config();
    const response = await put(body, cfg);
    expect(response.status).toBe(400);
    expect(cfg.autoReviewModel).toBeUndefined();
    expect(cfg.autoCompactModel).toBeUndefined();
  });

  test("rejects the whole update atomically when a later field is invalid", async () => {
    const cfg = config();
    const response = await put({
      autoReviewModel: "google-antigravity/gemini-3.7-flash",
      autoCompactModel: "google-antigravity/gemini-3.7-flash",
      helperTurnCodexRemainingPercentThreshold: 5,
      helperTurnScope: "native",
    }, cfg);
    expect(response.status).toBe(400);
    expect(cfg.autoReviewModel).toBeUndefined();
    expect(cfg.autoCompactModel).toBeUndefined();
    expect(cfg.helperTurnCodexRemainingPercentThreshold).toBeUndefined();
    expect(cfg.helperTurnScope).toBeUndefined();
  });
});
