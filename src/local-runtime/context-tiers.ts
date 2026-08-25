/**
 * Fixed Codex catalog variants for Huihui Qwen3.8's selectable context windows.
 *
 * Codex assigns exactly one `context_window` and one
 * `auto_compact_token_limit` to a catalog model. `service_tier` is only an
 * opaque request option; it cannot change either catalog value. Publishing
 * context sizes as service tiers therefore lets Codex budget a request against
 * one window while llama.cpp is running another.
 *
 * Each supported Qwen window is consequently a real catalog model id. The
 * openai-chat adapter strips the trailing bracket suffix before sending the id
 * to llama.cpp, so both rows still address the same server alias. The bare
 * id is deliberately the accepted 192K row. The 128K row remains available for
 * lower-memory sessions and is always explicit in the id.
 *
 * The compaction values are explicit operational policy, not calculated at
 * runtime. They reproduce the measured Codex trigger point (85.5% of catalog
 * context) but remain reviewable and test-pinned if that general policy ever
 * changes.
 *
 * Trimmed from six rows to two on 2026-07-29 at the user's request: six local
 * entries dominated the picker. This is the only honest lever for that. Codex's
 * Speed control sends a `service_tier` id, and `ModelServiceTier` is
 * `{ id, name, description }` with `additional_speed_tiers: Vec<String>` — no
 * context field exists on either, so a speed tier physically cannot carry a
 * window. Publishing one row and switching the allocation underneath it would
 * make Codex budget and auto-compact against a number llama.cpp is not running.
 * See ADR 0008 and upstream openai/codex#13653.
 */

export interface QwenContextVariant {
  label: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
}

export const QWEN_CONTEXT_VARIANTS: readonly QwenContextVariant[] = [
  { label: "128K", contextWindow: 131_072, autoCompactTokenLimit: 112_066 },
  { label: "192K", contextWindow: 196_608, autoCompactTokenLimit: 168_099 },
] as const;

export const QWEN_DEFAULT_CONTEXT = 196_608;

export function qwenContextVariantForContext(
  contextWindow: number,
): QwenContextVariant | undefined {
  return QWEN_CONTEXT_VARIANTS.find(variant => variant.contextWindow === contextWindow);
}

/** Codex-facing id for one fixed row. The accepted 192K default stays bare. */
export function qwenContextVariantModelId(
  baseModelId: string,
  contextWindow: number,
): string {
  const variant = qwenContextVariantForContext(contextWindow);
  if (!variant) throw new Error("QWEN_CONTEXT_VARIANT_INVALID");
  return contextWindow === QWEN_DEFAULT_CONTEXT
    ? baseModelId
    : `${baseModelId}[${variant.label}]`;
}

/**
 * Resolve a bare or provider-namespaced Qwen model id to its fixed row.
 *
 * Strict matching is intentional. Old `[8K]`, `[24K]`, `[48K]`, and `[96K]`
 * ids must not silently select a different runtime allocation.
 */
export function qwenContextVariantForModelId(
  modelId: unknown,
  baseModelId: string,
): QwenContextVariant | undefined {
  if (typeof modelId !== "string" || !modelId.trim()) return undefined;
  const namespacedPrefix = modelId.lastIndexOf("/");
  const localId = namespacedPrefix >= 0 ? modelId.slice(namespacedPrefix + 1) : modelId;
  return QWEN_CONTEXT_VARIANTS.find(variant => (
    localId === qwenContextVariantModelId(baseModelId, variant.contextWindow)
  ));
}

export function qwenContextVariantDisplayName(variant: QwenContextVariant): string {
  return `Local | Qwen 3.8 27B · ${variant.label}`;
}
