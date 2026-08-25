import { useState } from "react";
import QuotaBars from "./QuotaBars";
import { IconRefresh } from "../icons";
import { useT } from "../i18n/shared";
import type { AccountQuota } from "../codex-quota-utils";

/**
 * Antigravity model quota, read from the `agy` CLI.
 *
 * Deliberately not polled. The CLI exposes quota only through its interactive
 * `/usage` panel, so one reading costs a full CLI session of roughly 20-40 s.
 * Mounting reads the server-side cache, which is free; only the refresh button
 * starts a session.
 */
export type AgyUsagePayload = {
  account: string | null;
  capturedAt: string | null;
  lastAttemptAt: string | null;
  lastFailure: string | null;
  stale: boolean;
  windows: { label: string; percent: number; resetAt?: number }[];
};

/**
 * Module-level rather than a `useCallback` so the component holds no fetch
 * closure, and a failure becomes ordinary data instead of a second error state.
 */
async function fetchUsage(apiBase: string): Promise<AgyUsagePayload> {
  try {
    const response = await fetch(`${apiBase}/api/agy-usage/refresh`, { method: "POST" });
    return await response.json() as AgyUsagePayload;
  } catch {
    return {
      account: null,
      capturedAt: null,
      lastAttemptAt: null,
      lastFailure: "request-failed",
      stale: false,
      windows: [],
    };
  }
}

/**
 * `updatedAt` is derived only from the payload. Calling `Date.now()` here would
 * be impure during render and produce a different value on every re-render.
 */
function toQuota(payload: AgyUsagePayload | null): AccountQuota | null {
  if (!payload || payload.windows.length === 0) return null;
  const capturedMs = payload.capturedAt ? Date.parse(payload.capturedAt) : Number.NaN;
  return {
    customWindows: payload.windows,
    updatedAt: Number.isFinite(capturedMs) ? capturedMs : 0,
  };
}

export default function AntigravityQuotaCard({
  apiBase,
  title,
  threshold = 80,
}: {
  apiBase: string;
  /** Distinguishes the accounts, e.g. "Antigravity" vs "Antigravity MCP (AGY)". */
  title: string;
  threshold?: number;
}) {
  const t = useT();
  const [data, setData] = useState<AgyUsagePayload | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Nothing is fetched until the button is pressed.
   *
   * Two reasons, both deliberate. A reading costs a full agy CLI session of
   * roughly 20-40 s, so this is an explicit operator action rather than
   * something that happens because a page rendered. And this card is mounted
   * inside CodexAccountPool: a component that fetches on mount would issue a
   * request in every test and every render of its parent, which it did --
   * unmocked, it took one suite from 0.7 s to 374 s.
   */
  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      setData(await fetchUsage(apiBase));
    } finally {
      setBusy(false);
    }
  };

  const quota = toQuota(data);
  // Only a failure with nothing cached leaves the card with nothing to show.
  const hardFailure = data?.lastFailure && data.windows.length === 0
    ? data.lastFailure
    : null;

  return (
    <div className="agy-quota-card">
      <div className="agy-quota-head">
        <div>
          <span className="agy-quota-title">{title}</span>
          {data?.account && <span className="agy-quota-account muted">{data.account}</span>}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void refresh()}
          disabled={busy}
          title={t("agyUsage.refreshHint")}
        >
          <IconRefresh width={14} aria-hidden="true" />
          {busy ? t("agyUsage.reading") : t("agyUsage.refresh")}
        </button>
      </div>

      {quota
        ? <QuotaBars quota={quota} plan={null} threshold={threshold} t={t} layout="stacked" />
        : !busy && !hardFailure && <p className="muted text-label">{t("agyUsage.never")}</p>}

      {data?.stale && (
        <p className="muted text-label" role="status">
          {t("agyUsage.stale", { reason: data.lastFailure ?? "" })}
        </p>
      )}
      {hardFailure && (
        <p className="pwi-settings-msg pwi-settings-msg--err" role="alert">
          {t("agyUsage.failed", { reason: hardFailure })}
        </p>
      )}
    </div>
  );
}
