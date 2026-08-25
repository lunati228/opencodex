/**
 * Renders a provider's remaining quota as a short suffix for a catalog entry's `description`.
 *
 * ## Why `description` and not a picker row
 *
 * Codex's picker has no generic "extra row" mechanism — every row is a specific catalog field
 * it knows how to render (`supported_reasoning_levels`, `service_tiers`), and all of them are
 * functional controls. Putting usage in one would manufacture a control that looks selectable
 * and does nothing, which is exactly the "dead toggle" `normalizeServiceTiers` strips elsewhere.
 * `description` is display-only text under the model name, so it cannot misfire.
 *
 * ## Percent is USED, not remaining
 *
 * `ProviderQuota.percent` fields count consumption: the dashboard renders `percent: 0` as
 * "0% used", and the OpenAI report read `monthlyPercent: 100` on an account whose quota was in
 * fact exhausted. Two independent confirmations, so the suffix subtracts from 100 to show what
 * is left — which is what a picker reader actually wants to know.
 */
import type { ProviderQuota, ProviderQuotaResponse } from "../../providers/quota";

/** Windows worth showing, in the order a reader cares about: soonest-resetting first. */
interface QuotaPart {
  label: string;
  usedPercent: number;
}

function remaining(usedPercent: number): number {
  // Clamp because a provider may report >100 after an overage, and "-7% left" is nonsense.
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Ordered, de-duplicated windows for one provider's quota. */
export function quotaParts(quota: ProviderQuota): QuotaPart[] {
  const parts: QuotaPart[] = [];
  if (isPercent(quota.fiveHourPercent)) parts.push({ label: "5h", usedPercent: quota.fiveHourPercent });
  if (isPercent(quota.weeklyPercent)) parts.push({ label: "weekly", usedPercent: quota.weeklyPercent });
  if (isPercent(quota.monthlyPercent)) parts.push({ label: "monthly", usedPercent: quota.monthlyPercent });
  for (const window of quota.customWindows ?? []) {
    // Antigravity reports per-family windows labelled "Gem" / "Cla" rather than by duration.
    if (isPercent(window.percent) && typeof window.label === "string" && window.label.length > 0) {
      parts.push({ label: window.label, usedPercent: window.percent });
    }
  }
  return parts;
}

/**
 * `"weekly 28% left · 5h 10% left"`, or `""` when the provider reports nothing usable.
 *
 * Empty rather than "unknown": a model whose provider has no quota concept (a local engine, a
 * flat-rate key) should read exactly as it did before, not gain a puzzling placeholder.
 */
export function formatQuotaSuffix(quota: ProviderQuota | undefined): string {
  if (!quota) return "";
  const parts = quotaParts(quota);
  if (parts.length === 0) return "";
  return parts.map(part => `${part.label} ${remaining(part.usedPercent)}% left`).join(" · ");
}

/** Look up one provider's suffix inside a whole report. */
export function quotaSuffixForProvider(
  reports: ProviderQuotaResponse | null,
  providerId: string,
): string {
  const report = reports?.reports.find(entry => entry.provider === providerId);
  return formatQuotaSuffix(report?.quota);
}

/**
 * Append the suffix to a description, keeping the description authoritative.
 *
 * Idempotent on repeated catalog builds: the previous suffix is stripped before the new one is
 * added, so quota text never accumulates across refreshes. The separator is a marker rather
 * than plain punctuation for exactly that reason.
 */
export const QUOTA_SUFFIX_SEPARATOR = " — ";

export function withQuotaSuffix(description: string, suffix: string): string {
  const base = description.split(QUOTA_SUFFIX_SEPARATOR)[0];
  if (!suffix) return base;
  return `${base}${QUOTA_SUFFIX_SEPARATOR}${suffix}`;
}
