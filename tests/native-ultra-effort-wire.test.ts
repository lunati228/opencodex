import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// `ultra` is a PRODUCT TIER ("max, and delegate proactively"), never a wire value. The ChatGPT
// backend enumerates exactly none/minimal/low/medium/high/xhigh/max and rejects anything else
// with a 400 that fails the whole turn.
//
// parseRequest already degrades ultra -> max, but only into parsed.options.reasoning; the
// native passthrough forwards `_rawBody` VERBATIM, so the untouched `_rawBody.reasoning.effort`
// carried "ultra" all the way to OpenAI. nativeEffortClamp could not catch it either, because
// by the time it runs parsed.options.reasoning already reads "max" — which sol and terra
// genuinely support, so there was nothing left to clamp.
//
// Measured against the live backend before the fix: gpt-5.6-sol / terra / luna + ultra all
// returned 400 "Invalid value: 'ultra'."; after the fix all returned 200.

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

/**
 * This suite calls saveConfig(), which writes $OPENCODEX_HOME/config.json.
 *
 * Isolation comes from `bun scripts/test.ts`, which spawns the child with HOME, USERPROFILE,
 * OPENCODEX_HOME and CODEX_HOME redirected into a temp root. `bun test <file>` run directly
 * does NOT do that — bunfig.toml preloads only the ACL fake — so the very same code path
 * overwrites the developer's REAL ~/.opencodex/config.json. That happened during this work and
 * silently deleted the live customModels list plus two configured providers.
 *
 * Setting the env var in beforeEach is not sufficient protection on its own, so fail loudly
 * and immediately instead of writing somewhere real.
 */
function assertIsolatedHome(): void {
  const home = process.env.OPENCODEX_HOME;
  const temp = tmpdir();
  if (!home || !home.toLowerCase().startsWith(temp.toLowerCase())) {
    throw new Error(
      `Refusing to run: OPENCODEX_HOME (${home ?? "unset"}) is not inside ${temp}. `
      + "This suite writes config.json — run it via `bun scripts/test.ts` so HOME is isolated.",
    );
  }
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-ultra-wire-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-ultra-wire-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

/** Captures the body opencodex actually puts on the wire for the canonical ChatGPT backend. */
function mockNativeUpstream() {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* non-JSON */ }
      return Response.json({
        id: "resp_ultra",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return previous(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
    }
    return previous(input, init);
  }) as typeof fetch;
  return { upstream, captured };
}

function nativeForwardConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

async function wireEffortFor(model: string, requested: string): Promise<string | undefined> {
  const { upstream, captured } = mockNativeUpstream();
  saveConfig(nativeForwardConfig());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: ["Bear" + "er", "caller-token"].join(" "),
      },
      body: JSON.stringify({
        model,
        stream: false,
        store: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        reasoning: { effort: requested },
      }),
    });
    expect(response.status).toBe(200);
    const sent = captured.at(-1) as { reasoning?: { effort?: string } } | undefined;
    return sent?.reasoning?.effort;
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    globalThis.fetch = originalFetch;
  }
}

test("ultra never reaches the ChatGPT backend, even on models that advertise it", async () => {
  // sol and terra DO carry ultra in supported_reasoning_levels, which is exactly why this
  // leaked: every membership check upstream of the wire said the value was legal.
  expect(await wireEffortFor("gpt-5.6-sol", "ultra")).toBe("max");
  expect(await wireEffortFor("gpt-5.6-terra", "ultra")).toBe("max");
  // luna advertises max but not ultra; same wire answer.
  expect(await wireEffortFor("gpt-5.6-luna", "ultra")).toBe("max");
});

test("ultra lands on the older natives' real top rung", async () => {
  // gpt-5.5's ladder stops at xhigh, so ultra must come down two rungs, not one. This case
  // already worked via nativeEffortClamp and is pinned so the raw-body reconciliation cannot
  // regress it back up to max.
  expect(await wireEffortFor("gpt-5.5", "ultra")).toBe("xhigh");
});

test("efforts that are already valid are forwarded untouched", async () => {
  // The reconciliation must not become a blanket rewrite: max is real on gpt-5.6 natives and
  // downgrading it would silently cost the user the tier they selected.
  expect(await wireEffortFor("gpt-5.6-sol", "max")).toBe("max");
  expect(await wireEffortFor("gpt-5.6-sol", "high")).toBe("high");
  expect(await wireEffortFor("gpt-5.6-sol", "low")).toBe("low");
});
