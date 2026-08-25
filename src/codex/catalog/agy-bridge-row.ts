/**
 * Reserved identifiers for retired, display-only usage rows.
 *
 * They are deliberately not catalog entries anymore. Keeping the ids and
 * guard prevents a stale picker selection from falling through to a provider,
 * while catalog sync removes any cached copies.
 */
export const AGY_BRIDGE_ROW_SLUG = "agy-cli/usage";
export const AGY_PROVIDER_USAGE_ROW_SLUG = "agy-provider/usage";

export const AGY_BRIDGE_ROW_MESSAGE =
  "This retired usage readout is not a model and cannot serve a conversation. "
  + "The former AGY and MCP readouts represented different accounts; pick an Antigravity model instead.";

export function isAgyBridgeRowSlug(modelId: string): boolean {
  return modelId === AGY_BRIDGE_ROW_SLUG || modelId === AGY_PROVIDER_USAGE_ROW_SLUG;
}
