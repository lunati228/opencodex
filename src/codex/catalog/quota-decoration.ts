/**
 * Metadata-only quota refresh for the existing Codex catalog.
 *
 * This intentionally performs no provider discovery and never adds or reorders
 * a model. A prior attempt rebuilt the full catalog after quota refresh and
 * dropped five routed rows when live discovery degraded. This pass edits
 * display-only strings in place; its sole membership exception removes retired
 * OpenCodex-owned rows so a delayed decoration cannot restore them after sync.
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import {
  fetchProviderQuotaReports,
  getCachedProviderQuotaReports,
  type ProviderQuotaResponse,
} from "../../providers/quota";
import type { OcxConfig } from "../../types";
import { readCodexCatalogPath, type RawEntry } from "./parsing";
import { normalizePersistedPickerRows } from "./persisted-picker-rows";
import { quotaSuffixForProvider, withQuotaSuffix } from "./quota-suffix";

export function decorateCatalogQuotaRows(
  models: RawEntry[],
  reports: ProviderQuotaResponse | null,
): number {
  let changed = 0;
  for (const entry of models) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const slash = slug.indexOf("/");
    if (slash <= 0 || typeof entry.description !== "string") continue;
    const providerId = slug.slice(0, slash);
    const description = withQuotaSuffix(
      entry.description,
      quotaSuffixForProvider(reports, providerId),
    );
    if (description !== entry.description) {
      entry.description = description;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Refresh picker quota suffixes once, shortly after the proxy starts.
 *
 * The catalog is (re)built at startup while the quota cache is still cold, so
 * This is the same fire-and-forget shape as `primeCodexPoolQuotas`: it is never
 * awaited by the listener and never throws. The refresh is metadata-only apart
 * from retiring the two reserved rows that older OpenCodex versions generated.
 */
export async function primeCatalogQuotaDecoration(
  config: OcxConfig,
  fetchReports: (config: OcxConfig) => Promise<ProviderQuotaResponse> = c => fetchProviderQuotaReports(c),
): Promise<{ path: string; rows: number; written: boolean } | null> {
  try {
    const reports = await fetchReports(config);
    return refreshCatalogQuotaDecoration(reports);
  } catch {
    // A blocked network, an expired login, or a provider outage must not affect
    // startup: the rows keep their honest `not read` text until a later refresh.
    return null;
  }
}

export function refreshCatalogQuotaDecoration(
  reports: ProviderQuotaResponse | null = getCachedProviderQuotaReports(),
): { path: string; rows: number; written: boolean } {
  const path = readCodexCatalogPath();
  if (!existsSync(path)) return { path, rows: 0, written: false };
  try {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    if (!Array.isArray(catalog.models)) return { path, rows: 0, written: false };
    const persistedRows = catalog.models as RawEntry[];
    const normalizedRows = normalizePersistedPickerRows(persistedRows);
    const pickerRowsChanged = normalizedRows.length !== persistedRows.length
      || normalizedRows.some((entry, index) => entry !== persistedRows[index]);
    if (pickerRowsChanged) catalog.models = normalizedRows;
    const rows = decorateCatalogQuotaRows(catalog.models as RawEntry[], reports);
    if (rows > 0 || pickerRowsChanged) atomicWriteFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
    return { path, rows, written: rows > 0 || pickerRowsChanged };
  } catch {
    return { path, rows: 0, written: false };
  }
}
