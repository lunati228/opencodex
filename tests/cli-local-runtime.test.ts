import { describe, expect, test } from "bun:test";
import { handleLocalRuntimeCommand } from "../src/cli/local-runtime";

interface Call { path: string; method: string; body?: unknown }

/**
 * The managed local engine was GUI-only, which upstream's cli-headless-parity gate flags: a
 * headless operator could start the proxy but never see, size or stop ~28 GB of resident model.
 */
function harness(status: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const baseStatus = {
    state: "running",
    revision: 7,
    requested: { profileId: "qwen38-27b-q6kl", nCtx: 131072, reasoningEffort: "xhigh" },
    effective: { profileId: "qwen38-27b-q6kl", nCtx: 131072, model: "huihui-qwen3.8-27b-abliterated-q6-k-l" },
    contextConstraints: { min: 16384, max: 184320, step: 1024 },
    contextCheckpoints: [131072, 184320],
    controlEnabled: true,
    ...status,
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      path,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const payload = path === "/api/local-runtime/status" ? baseStatus : { accepted: true, revision: 8 };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, deps: { baseUrl: "http://127.0.0.1:10100", fetchImpl } };
}

describe("ocx local-runtime", () => {
  test("status reads the engine and needs no arguments", async () => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["status", "--json"], deps)).toBe(0);
    expect(calls).toEqual([{ path: "/api/local-runtime/status", method: "GET" }]);
  });

  test("status is the default subcommand", async () => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["--json"], deps)).toBe(0);
    expect(calls[0]!.path).toBe("/api/local-runtime/status");
  });

  test("human status prints the exact fixed 128K compaction threshold", async () => {
    const { deps } = harness();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      expect(await handleLocalRuntimeCommand(["status"], deps)).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines).toContain("context  131072 (compacts at 112066)");
  });

  // apply is a compare-and-swap on the supervisor revision and also needs the profile id, so the
  // command reads state first rather than making the caller supply either.
  test("context reads current state, then applies with that revision and profile", async () => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["context", "131072", "--json"], deps)).toBe(0);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "GET /api/local-runtime/status",
      "POST /api/local-runtime/apply",
    ]);
    expect(calls[1]!.body).toEqual({
      profileId: "qwen38-27b-q6kl",
      nCtx: 131072,
      expectedRevision: 7,
      reasoningEffort: "xhigh",
    });
  });

  test.each([
    ["below the minimum", "8192"],
    ["above the maximum", "524288"],
    ["on the broad step grid but outside the fixed choices", "49152"],
    ["the retired 64K choice", "65536"],
    ["off the broad step grid", "65000"],
    ["not a number", "big"],
  ])("context refuses a value %s without touching the engine", async (_label, value) => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["context", value], deps)).not.toBe(0);
    expect(calls.some(c => c.path === "/api/local-runtime/apply")).toBe(false);
  });

  test("context accepts the verified 180K choice", async () => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["context", "184320", "--json"], deps)).toBe(0);
    expect(calls[1]!.body).toMatchObject({ nCtx: 184320 });
  });

  test("autostart sends the exact body the route accepts", async () => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand(["autostart", "off", "--json"], deps)).toBe(0);
    expect(calls[0]).toEqual({
      path: "/api/local-runtime/autostart",
      method: "PUT",
      body: { enabled: false },
    });
  });

  test.each(["start", "stop"])("%s posts and takes no body", async sub => {
    const { calls, deps } = harness();
    expect(await handleLocalRuntimeCommand([sub, "--json"], deps)).toBe(0);
    expect(calls[0]).toEqual({ path: `/api/local-runtime/${sub}`, method: "POST" });
  });

  test.each([
    ["an unknown subcommand", ["frobnicate"]],
    ["a bad autostart value", ["autostart", "maybe"]],
    ["a stray argument", ["status", "extra"]],
  ])("rejects %s", async (_label, argv) => {
    const { deps } = harness();
    expect(await handleLocalRuntimeCommand(argv, deps)).not.toBe(0);
  });
});
