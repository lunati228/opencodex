/**
 * Redirect targets for Codex's two automatic HELPER turns — auto-review and auto-compaction.
 *
 * Both run without the user picking a model, and both defaulted to somewhere the user did not
 * choose:
 *
 * - Auto-review arrives under its own slug. Codex's catalog ships `codex-auto-review` with
 *   `visibility: "hide"`, so it never shows in the picker, and the slug is not in the
 *   gpt-/o1-/o3-/o4- family the router treats as bare-OpenAI. It therefore fell through every
 *   routing rule to `config.defaultProvider` — which is why a review still went to OpenAI while
 *   the conversation itself ran on a local model.
 *
 * - Auto-compaction has NO slug of its own. It arrives on the conversation's model with a
 *   `{"type":"compaction_trigger"}` item, which the parser flags as `_compactionRequest`
 *   (src/responses/compaction.ts explains the wire contract). So it is identified by that flag,
 *   never by the model id, and it runs on whatever model the conversation is using.
 *
 * Redirecting them is the same idea applied to two different signals.
 */
import type { OcxConfig } from "../types";
import { CODEX_CAPACITY_MAX_QUOTA_AGE_MS } from "../providers/codex-capacity";
import type { ProviderQuotaResponse } from "../providers/quota";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";

export const CODEX_AUTO_REVIEW_SLUG = "codex-auto-review";
/**
 * Catalog-only marker written onto routed model rows. Native rows never receive
 * it. In quota-threshold mode the marker is stable across quota refreshes and
 * means that the review originated from an external conversation.
 */
export const EXTERNAL_AUTO_REVIEW_SLUG = "opencodex-external-auto-review";

export type HelperTurnScope = "all" | "external";

/** Deterministic quota input for tests; production reads the provider-report cache. */
export interface HelperTurnQuotaContext {
  reports: ProviderQuotaResponse | null;
  now?: number;
}

const CODEX_REMAINING_THRESHOLD_FIELD = "helperTurnCodexRemainingPercentThreshold" as const;

function configuredTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Model that should serve auto-review, or undefined to keep today's behaviour.
 * A self-reference is ignored rather than followed — it would recurse into this same redirect.
 */
export function autoReviewModelOverride(config: OcxConfig): string | undefined {
  const target = configuredTarget(config.autoReviewModel);
  return target === CODEX_AUTO_REVIEW_SLUG || target === EXTERNAL_AUTO_REVIEW_SLUG
    ? undefined
    : target;
}

export function helperTurnScope(config: OcxConfig): HelperTurnScope {
  return config.helperTurnScope === "external" ? "external" : "all";
}

export function helperTurnReasoningEffort(config: OcxConfig): string | undefined {
  return configuredTarget(config.helperTurnReasoningEffort);
}

/** Valid configured threshold, expressed as percentage points remaining. */
export function helperTurnCodexRemainingPercentThreshold(config: OcxConfig): number | undefined {
  const value = config.helperTurnCodexRemainingPercentThreshold;
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100
    ? value
    : undefined;
}

function quotaGateIsConfigured(config: OcxConfig): boolean {
  const raw = config as OcxConfig & Record<string, unknown>;
  return Object.hasOwn(raw, CODEX_REMAINING_THRESHOLD_FIELD)
    && raw[CODEX_REMAINING_THRESHOLD_FIELD] !== undefined;
}

function normalizedQuotaPercent(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 100
    ? value
    : undefined;
}

function maximumKnownCodexUtilisation(
  reports: ProviderQuotaResponse | null,
  now: number,
): number | undefined {
  const report = reports?.reports.find(item => item.provider === OPENAI_CODEX_PROVIDER_ID);
  if (!report || !Number.isFinite(report.updatedAt)) return undefined;
  // Match the Usage page exactly: a row is stale at the 30-minute boundary.
  if (now - report.updatedAt >= CODEX_CAPACITY_MAX_QUOTA_AGE_MS) return undefined;
  const values = [
    report.quota.fiveHourPercent,
    report.quota.weeklyPercent,
    report.quota.monthlyPercent,
    ...(report.quota.customWindows ?? []).map(window => window.percent),
  ].flatMap(value => {
    const normalized = normalizedQuotaPercent(value);
    return normalized === undefined ? [] : [normalized];
  });
  return values.length > 0 ? Math.max(...values) : undefined;
}

/**
 * Whether the low-quota override is active for native review. External-origin
 * review and compaction use their configured targets at every quota level.
 *
 * No threshold preserves the original always-on override for compatibility.
 * A present but malformed threshold, missing quota, or stale quota fails to the
 * native/default helper path. Provider percentages are USED, so a threshold of
 * 5 activates at 95% used.
 */
export function helperTurnQuotaOverrideActive(
  config: OcxConfig,
  context?: HelperTurnQuotaContext,
): boolean {
  if (!quotaGateIsConfigured(config)) return true;
  const remainingThreshold = helperTurnCodexRemainingPercentThreshold(config);
  if (remainingThreshold === undefined) return false;
  const usedPercent = maximumKnownCodexUtilisation(
    context?.reports ?? null,
    context?.now ?? Date.now(),
  );
  return usedPercent !== undefined && usedPercent >= 100 - remainingThreshold;
}

/**
 * Resolve only the review slugs this configuration owns.
 *
 * In legacy external-only mode the native `codex-auto-review` slug is a no-op.
 * In threshold mode native review may switch at low quota, while routed catalog
 * rows use EXTERNAL_AUTO_REVIEW_SLUG as an unambiguous source marker.
 */
export function autoReviewTurnModelId(
  config: OcxConfig,
  modelId: string,
  quotaContext?: HelperTurnQuotaContext,
): string {
  const target = autoReviewModelOverride(config);
  if (modelId === EXTERNAL_AUTO_REVIEW_SLUG) {
    // The catalog alias is a durable external-origin marker. External review
    // always uses the configured reviewer; quota gates only native review.
    if (!target) return CODEX_AUTO_REVIEW_SLUG;
    return target;
  }
  if (modelId === CODEX_AUTO_REVIEW_SLUG && target) {
    if (quotaGateIsConfigured(config)) {
      return helperTurnQuotaOverrideActive(config, quotaContext) ? target : modelId;
    }
    if (helperTurnScope(config) === "all") return target;
  }
  return modelId;
}

/** Configured review target only when this helper turn is actually using it. */
export function activeAutoReviewModelOverrideForTurn(
  config: OcxConfig,
  modelId: string,
  quotaContext?: HelperTurnQuotaContext,
): string | undefined {
  if (modelId !== CODEX_AUTO_REVIEW_SLUG && modelId !== EXTERNAL_AUTO_REVIEW_SLUG) {
    return undefined;
  }
  const target = autoReviewModelOverride(config);
  return target && autoReviewTurnModelId(config, modelId, quotaContext) === target
    ? target
    : undefined;
}

export function externalAutoReviewCatalogOverride(config: OcxConfig): string | undefined {
  if (!autoReviewModelOverride(config)) return undefined;
  return quotaGateIsConfigured(config) || helperTurnScope(config) === "external"
    ? EXTERNAL_AUTO_REVIEW_SLUG
    : undefined;
}

/** Model that should serve auto-compaction, or undefined to summarize on the conversation model. */
export function autoCompactModelOverride(config: OcxConfig): string | undefined {
  return configuredTarget(config.autoCompactModel);
}

/** Configured compaction target only when this helper turn is actually using it. */
export function activeAutoCompactModelOverrideForTurn(
  config: OcxConfig,
  isCompaction: boolean,
  sourceIsExternal = false,
  _quotaContext?: HelperTurnQuotaContext,
): string | undefined {
  if (!isCompaction) return undefined;
  const target = autoCompactModelOverride(config);
  if (!target) return undefined;
  if (quotaGateIsConfigured(config)) {
    return sourceIsExternal ? target : undefined;
  }
  if (helperTurnScope(config) === "external" && !sourceIsExternal) return undefined;
  return target;
}

/**
 * Model id a compaction turn should route to. Compaction is flagged, not slugged, so the caller
 * passes the marker; a non-compaction turn is always returned unchanged.
 */
export function compactionTurnModelId(
  config: OcxConfig,
  modelId: string,
  isCompaction: boolean,
  sourceIsExternal = false,
  quotaContext?: HelperTurnQuotaContext,
): string {
  return activeAutoCompactModelOverrideForTurn(
    config,
    isCompaction,
    sourceIsExternal,
    quotaContext,
  ) ?? modelId;
}
