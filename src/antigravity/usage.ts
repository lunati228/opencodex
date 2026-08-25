/**
 * Antigravity (agy CLI) quota, read on demand.
 *
 * `agy` has no non-interactive usage command and never writes quota to disk, so
 * the only source is its `/usage` TUI panel. `tools/agy-usage/read_agy_usage.py`
 * renders that panel under ConPTY and emits JSON; this module runs it, converts
 * the result into the shape the quota bars already use, and caches it.
 *
 * Reads are explicit, never polled. One read costs a full CLI session (roughly
 * 20-40 s), so a background refresh loop would be both slow and rude to the
 * upstream service. The UI drives this with a refresh button.
 *
 * Everything fails soft: a scrape failure returns the previous cached value
 * marked stale rather than an error page, and never a fabricated number.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

export interface AgyQuotaWindow {
  /** Verbatim panel label, e.g. "Weekly Limit". */
  label: string;
  /** Percent of the allowance still available, as printed by the CLI. */
  percentRemaining: number;
  /** Absolute reset instant, or null when the panel showed no countdown. */
  resetAt: string | null;
}

export interface AgyQuotaGroup {
  /** e.g. "GEMINI MODELS". */
  name: string;
  /** e.g. ["Gemini Flash", "Gemini Pro"]. */
  models: string[];
  windows: AgyQuotaWindow[];
}

export interface AgyQuotaSnapshot {
  ok: true;
  /** Which Google account the CLI is authenticated as. */
  account: string | null;
  capturedAt: string;
  groups: AgyQuotaGroup[];
}

export interface AgyQuotaFailure {
  ok: false;
  reason: string;
}

export type AgyQuotaResult = AgyQuotaSnapshot | AgyQuotaFailure;

const SCRIPT_RELATIVE = win32.join("tools", "agy-usage", "read_agy_usage.py");
const READ_TIMEOUT_MS = 180_000;

/**
 * The scrape needs `pywinpty`, which is not a dependency of this project. The
 * Antigravity MCP bridge already ships a virtualenv containing it, so that is
 * preferred; an explicit override wins over everything for operators who keep
 * their own interpreter.
 */
export function resolvePython(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OPENCODEX_AGY_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;
  const bridge = win32.join(
    env.USERPROFILE ?? homedir(),
    ".codex",
    "tools",
    "codex-antigravity-bridge",
    ".venv",
    "Scripts",
    "python.exe",
  );
  if (existsSync(bridge)) return bridge;
  return null;
}

function runScraper(
  python: string,
  scriptPath: string,
  cwd: string,
): Promise<AgyQuotaResult> {
  return new Promise(resolve => {
    let stdout = "";
    let settled = false;
    const finish = (result: AgyQuotaResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(python, [scriptPath, "--cwd", cwd], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The scrape is advisory; a failed kill must not throw here.
      }
      finish({ ok: false, reason: "timeout" });
    }, READ_TIMEOUT_MS);

    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("error", () => finish({ ok: false, reason: "spawn-failed" }));
    // `exit` rather than `close`: the script is short-lived and this avoids
    // hanging on an inherited pipe that never reaches EOF.
    child.on("exit", () => {
      const trimmed = stdout.trim();
      if (!trimmed) return finish({ ok: false, reason: "no-output" });
      try {
        const parsed = JSON.parse(trimmed.split("\n").at(-1) ?? "") as AgyQuotaResult;
        finish(parsed?.ok ? parsed : { ok: false, reason: parsed?.reason ?? "unparsed" });
      } catch {
        finish({ ok: false, reason: "invalid-json" });
      }
    });
  });
}

export interface AgyUsageCacheEntry {
  snapshot: AgyQuotaSnapshot | null;
  lastAttemptAt: string | null;
  lastFailure: string | null;
}

const cache: AgyUsageCacheEntry = {
  snapshot: null,
  lastAttemptAt: null,
  lastFailure: null,
};

export function readAgyUsageCache(): AgyUsageCacheEntry {
  return { ...cache };
}

/** Exposed so tests can start from a known state. */
export function resetAgyUsageCache(): void {
  cache.snapshot = null;
  cache.lastAttemptAt = null;
  cache.lastFailure = null;
}

let inFlight: Promise<AgyUsageCacheEntry> | null = null;

/**
 * Refresh the cached snapshot. Concurrent callers share one CLI session --
 * launching several agy processes at once would race for the same terminal
 * resources and waste tens of seconds each.
 */
export function refreshAgyUsage(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgyUsageCacheEntry> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    cache.lastAttemptAt = new Date().toISOString();
    const python = resolvePython(env);
    if (!python) {
      cache.lastFailure = "python-with-pywinpty-not-found";
      return readAgyUsageCache();
    }
    const scriptPath = win32.join(repoRoot, SCRIPT_RELATIVE);
    if (!existsSync(scriptPath)) {
      cache.lastFailure = "scraper-script-missing";
      return readAgyUsageCache();
    }
    const result = await runScraper(python, scriptPath, repoRoot);
    if (result.ok) {
      cache.snapshot = result;
      cache.lastFailure = null;
    } else {
      // Keep the previous snapshot; the UI marks it stale rather than blanking.
      cache.lastFailure = result.reason;
    }
    return readAgyUsageCache();
  })();
  void inFlight.finally(() => { inFlight = null; });
  return inFlight;
}

export interface QuotaBarWindow {
  label: string;
  /** Percent CONSUMED, which is what the quota bars render. */
  percent: number;
  /** Epoch seconds, or undefined when no reset was shown. */
  resetAt?: number;
}

/**
 * Convert a snapshot into consumed-percentage rows.
 *
 * The CLI prints REMAINING ("97.91%" beside "98% remaining") while the quota
 * bars render CONSUMED, so every value is inverted here exactly once. Getting
 * this backwards would show a full allowance as an exhausted one.
 */
export function toQuotaWindows(snapshot: AgyQuotaSnapshot): QuotaBarWindow[] {
  const rows: QuotaBarWindow[] = [];
  for (const group of snapshot.groups) {
    const groupLabel = titleCaseGroup(group.name);
    for (const window of group.windows) {
      const resetMs = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
      rows.push({
        label: `${groupLabel} · ${shortWindowLabel(window.label)}`,
        percent: clampPercent(100 - window.percentRemaining),
        ...(Number.isFinite(resetMs)
          ? { resetAt: Math.floor(resetMs / 1000) }
          : {}),
      });
    }
  }
  return rows;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Acronyms the panel prints that must not be lowercased into words. */
const GROUP_ACRONYMS = new Set(["GPT", "AI", "OSS"]);
/** Joining words stay lowercase so "CLAUDE AND GPT" reads as prose. */
const GROUP_MINOR_WORDS = new Set(["and", "or", "the", "of"]);

/** "GEMINI MODELS" -> "Gemini", "CLAUDE AND GPT MODELS" -> "Claude and GPT". */
function titleCaseGroup(name: string): string {
  const withoutSuffix = name.replace(/\s*MODELS\s*$/i, "").trim() || name;
  return withoutSuffix
    .split(/\s+/)
    .map((word, index) => {
      if (GROUP_ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
      const lower = word.toLowerCase();
      // Never lowercase the first word, even if it is a joining word.
      if (index > 0 && GROUP_MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** "Five Hour Limit" -> "5h", "Weekly Limit" -> "Weekly". */
function shortWindowLabel(label: string): string {
  const normalized = label.replace(/\s*Limit\s*$/i, "").trim();
  if (/^five hour$/i.test(normalized)) return "5h";
  return normalized || label;
}
