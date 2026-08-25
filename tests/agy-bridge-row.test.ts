import { describe, expect, test } from "bun:test";
import {
  AGY_BRIDGE_ROW_MESSAGE,
  AGY_BRIDGE_ROW_SLUG,
  AGY_PROVIDER_USAGE_ROW_SLUG,
  isAgyBridgeRowSlug,
} from "../src/codex/catalog/agy-bridge-row";
import { buildCatalogEntries, mergeCatalogEntriesForSync } from "../src/codex/catalog/sync";
import { routeModel } from "../src/router";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxConfig } from "../src/types";

const antigravityModel: CatalogModel = { id: "gemini-3.7-flash", provider: "google-antigravity" };

function slugs(entries: ReturnType<typeof buildCatalogEntries>): string[] {
  return entries.map(e => String(e.slug));
}

describe("retired AGY/MCP usage picker rows", () => {
  test("does not add separate AGY-login or MCP usage rows when Antigravity is configured", () => {
    const entries = buildCatalogEntries(null, [], [antigravityModel]);
    expect(slugs(entries)).not.toContain(AGY_BRIDGE_ROW_SLUG);
    expect(slugs(entries)).not.toContain(AGY_PROVIDER_USAGE_ROW_SLUG);
  });

  test("stays away when Antigravity is not configured", () => {
    const entries = buildCatalogEntries(null, ["gpt-5.6-sol"], []);
    expect(slugs(entries)).not.toContain(AGY_BRIDGE_ROW_SLUG);
  });

  test("purges cached legacy usage rows during catalog sync", () => {
    const entries = mergeCatalogEntriesForSync([
      { slug: AGY_PROVIDER_USAGE_ROW_SLUG, display_name: "AGY Usage", visibility: "list" },
      { slug: AGY_BRIDGE_ROW_SLUG, display_name: "MCP Usage", visibility: "list" },
    ], [], new Map(), [], false);
    expect(slugs(entries)).not.toContain(AGY_PROVIDER_USAGE_ROW_SLUG);
    expect(slugs(entries)).not.toContain(AGY_BRIDGE_ROW_SLUG);
  });
});

describe("selecting the row does nothing, loudly", () => {
  const config = {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
  } as unknown as OcxConfig;

  // The real hazard: `agy-cli` is not a configured provider, so without an explicit guard this
  // slug falls through every routing rule to defaultProvider and quietly runs the turn on OpenAI.
  test("routing refuses it instead of falling through to the default provider", () => {
    expect(() => routeModel(config, AGY_BRIDGE_ROW_SLUG)).toThrow(AGY_BRIDGE_ROW_MESSAGE);
    expect(() => routeModel(config, AGY_PROVIDER_USAGE_ROW_SLUG)).toThrow(AGY_BRIDGE_ROW_MESSAGE);
  });

  test("the refusal identifies the separate account boundary", () => {
    expect(AGY_BRIDGE_ROW_MESSAGE).toContain("different account");
  });

  test.each(["agy-cli", "agy-cli/usage-2", "google-antigravity/gemini-3.7-flash", "gpt-5.6-sol"])(
    "%p is not mistaken for the readout row",
    slug => expect(isAgyBridgeRowSlug(slug)).toBe(false),
  );
});
