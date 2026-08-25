import {
  qwenContextVariantDisplayName,
  qwenContextVariantForModelId,
} from "../../local-runtime/context-tiers";
import { QWEN_PROFILE } from "../../local-runtime/profile";
import { isAgyBridgeRowSlug } from "./agy-bridge-row";
import type { RawEntry } from "./parsing";

/**
 * Repair known OpenCodex-owned picker state while retaining every unrelated
 * catalog row verbatim. This runs at persistence boundaries because cache-only
 * refreshes do not rebuild the provider catalog.
 */
export function normalizePersistedPickerRows(entries: readonly RawEntry[]): RawEntry[] {
  const normalized: RawEntry[] = [];
  for (const entry of entries) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (isAgyBridgeRowSlug(slug)) continue;

    const slash = slug.indexOf("/");
    const providerId = slash > 0 ? slug.slice(0, slash) : "";
    const modelId = slash > 0 ? slug.slice(slash + 1) : "";
    const qwenVariant = providerId === QWEN_PROFILE.providerId
      ? qwenContextVariantForModelId(modelId, QWEN_PROFILE.modelId)
      : undefined;
    const displayName = qwenVariant ? qwenContextVariantDisplayName(qwenVariant) : undefined;
    normalized.push(displayName !== undefined && entry.display_name !== displayName
      ? { ...entry, display_name: displayName }
      : entry);
  }
  return normalized;
}
