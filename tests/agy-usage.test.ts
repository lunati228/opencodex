import { describe, expect, test } from "bun:test";
import {
  resolvePython,
  toQuotaWindows,
  type AgyQuotaSnapshot,
} from "../src/antigravity/usage";

/**
 * Captured verbatim from a real `agy` 1.1.7 `/usage` panel on 2026-07-27.
 * Keeping a real capture rather than an invented one means the conversion is
 * tested against the shape the CLI actually prints, including the fact that a
 * five-hour window at full allowance shows no countdown at all.
 */
const REAL_SNAPSHOT: AgyQuotaSnapshot = {
  ok: true,
  account: "someone@example.com",
  capturedAt: "2026-07-27T15:02:05.763Z",
  groups: [
    {
      name: "GEMINI MODELS",
      models: ["Gemini Flash", "Gemini Pro"],
      windows: [
        {
          label: "Weekly Limit",
          percentRemaining: 97.91,
          resetAt: "2026-07-29T16:16:05.763Z",
        },
        { label: "Five Hour Limit", percentRemaining: 100, resetAt: null },
      ],
    },
    {
      name: "CLAUDE AND GPT MODELS",
      models: ["Claude Opus", "Claude Sonnet", "GPT-OSS"],
      windows: [
        {
          label: "Weekly Limit",
          percentRemaining: 69.14,
          resetAt: "2026-07-29T16:17:05.763Z",
        },
        { label: "Five Hour Limit", percentRemaining: 100, resetAt: null },
      ],
    },
  ],
};

describe("agy quota conversion", () => {
  test("inverts remaining into consumed exactly once", () => {
    const rows = toQuotaWindows(REAL_SNAPSHOT);

    // The CLI prints REMAINING; the bars render CONSUMED. Getting this
    // backwards would show a nearly-full allowance as nearly exhausted.
    const geminiWeekly = rows.find(row => row.label === "Gemini · Weekly");
    expect(geminiWeekly?.percent).toBeCloseTo(2.09, 5);

    const claudeWeekly = rows.find(row => row.label === "Claude and GPT · Weekly");
    expect(claudeWeekly?.percent).toBeCloseTo(30.86, 5);

    // 100% remaining is 0% consumed, not a full bar.
    for (const row of rows.filter(entry => entry.label.endsWith("5h"))) {
      expect(row.percent).toBe(0);
    }
  });

  test("emits one row per window across every group", () => {
    const rows = toQuotaWindows(REAL_SNAPSHOT);

    expect(rows.map(row => row.label)).toEqual([
      "Gemini · Weekly",
      "Gemini · 5h",
      "Claude and GPT · Weekly",
      "Claude and GPT · 5h",
    ]);
  });

  test("converts reset instants to epoch seconds and omits absent ones", () => {
    const rows = toQuotaWindows(REAL_SNAPSHOT);

    const weekly = rows.find(row => row.label === "Gemini · Weekly");
    expect(weekly?.resetAt).toBe(Math.floor(Date.parse("2026-07-29T16:16:05.763Z") / 1000));

    // A window with no countdown must not invent one.
    const fiveHour = rows.find(row => row.label === "Gemini · 5h");
    expect(fiveHour?.resetAt).toBeUndefined();
  });

  test("clamps out-of-range percentages instead of rendering a broken bar", () => {
    const rows = toQuotaWindows({
      ...REAL_SNAPSHOT,
      groups: [{
        name: "ODD MODELS",
        models: [],
        windows: [
          { label: "Weekly Limit", percentRemaining: 140, resetAt: null },
          { label: "Monthly Limit", percentRemaining: -20, resetAt: null },
        ],
      }],
    });

    expect(rows[0]?.percent).toBe(0);
    expect(rows[1]?.percent).toBe(100);
  });

  test("handles a group with no recognisable suffix", () => {
    const rows = toQuotaWindows({
      ...REAL_SNAPSHOT,
      groups: [{
        name: "GEMINI",
        models: [],
        windows: [{ label: "Weekly Limit", percentRemaining: 50, resetAt: null }],
      }],
    });

    expect(rows[0]?.label).toBe("Gemini · Weekly");
    expect(rows[0]?.percent).toBe(50);
  });
});

describe("agy scraper interpreter discovery", () => {
  test("an explicit override is only honoured when it exists", () => {
    expect(resolvePython({ OPENCODEX_AGY_PYTHON: "Z:\\nope\\python.exe" }))
      .not.toBe("Z:\\nope\\python.exe");
  });

  test("returns null rather than guessing when nothing is available", () => {
    // pywinpty is not a dependency of this project, so an interpreter that
    // cannot be confirmed must fail closed instead of being spawned blindly.
    expect(resolvePython({ USERPROFILE: "Z:\\no-such-profile" })).toBeNull();
  });
});
