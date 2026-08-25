import { win32 } from "node:path";
import {
  readAgyUsageCache,
  refreshAgyUsage,
  toQuotaWindows,
} from "../../antigravity/usage";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { refreshCatalogQuotaDecoration } from "../../codex/catalog/quota-decoration";

/**
 * Repo root, derived from this file's own location rather than `process.cwd()`.
 * The server is normally started from an arbitrary working directory, so cwd
 * would not reliably locate `tools/agy-usage/`.
 */
const REPO_ROOT = win32.resolve(import.meta.dir, "..", "..", "..");

function payload(): Record<string, unknown> {
  const entry = readAgyUsageCache();
  return {
    account: entry.snapshot?.account ?? null,
    capturedAt: entry.snapshot?.capturedAt ?? null,
    lastAttemptAt: entry.lastAttemptAt,
    lastFailure: entry.lastFailure,
    // Present but stale when the most recent refresh failed, so the UI can say
    // "these numbers are old" instead of showing nothing or showing a guess.
    stale: entry.snapshot !== null && entry.lastFailure !== null,
    windows: entry.snapshot ? toQuotaWindows(entry.snapshot) : [],
    groups: entry.snapshot?.groups ?? [],
  };
}

export async function handleAgyUsageRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/agy-usage/")) return null;

  // Cache read only. Never triggers a CLI session, so it is safe to call on
  // every page render.
  //
  // The GUI card deliberately does NOT call this on mount, so this route has no
  // browser caller today. It is kept because it is the only way to inspect the
  // cached reading without paying for a ~20-40 s agy session -- which is what
  // the install-time checks use. See BACKLOG "AGY quota card shows nothing
  // until refreshed" for why the mount read was removed.
  if (url.pathname === "/api/agy-usage/status" && req.method === "GET") {
    return jsonResponse(payload());
  }

  // Explicit refresh. Costs a full agy session (roughly 20-40 s), which is why
  // it is a button rather than a poll.
  if (url.pathname === "/api/agy-usage/refresh" && req.method === "POST") {
    const entry = await refreshAgyUsage(REPO_ROOT);
    refreshCatalogQuotaDecoration();
    return jsonResponse(payload(), entry.lastFailure && !entry.snapshot ? 503 : 200);
  }

  return null;
}
