import { describe, expect, test } from "bun:test";
import { routeModel } from "../../src/router";
import { decideCompanionAction, initialCompanionState } from "../../src/codex/companion";
import { applyMultiAgentMode } from "../../src/codex/catalog/parsing";
import { performStopTeardown } from "../../src/server/stop-teardown";
import type { OcxConfig } from "../../src/types";

const native: OcxConfig = {
  port: 10100, defaultProvider: "openai", providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
  },
};

describe("external model startup routing", () => {
  test.each(["google-antigravity/gemini-3.8-flash", "qwen-local/huihui-qwen3.8-27b-abliterated-q6-k-l"])(
    "missing provider cannot fall through to ChatGPT: %s", model => {
      expect(() => routeModel(native, model)).toThrow("No provider configured for external model");
    },
  );
  test("native Astra keeps its canonical route", () => {
    const route = routeModel(native, "gpt-6-astra");
    expect(route.providerName).toBe("openai");
    expect(route.modelId).toBe("gpt-6-astra");
    expect(route.provider.baseUrl).toBe(native.providers.openai.baseUrl);
  });
  test("declared slash-containing vendor ids still route to their configured provider", () => {
    const config: OcxConfig = { ...native, providers: { ...native.providers,
      vendor: { adapter: "openai-chat", baseUrl: "https://vendor.example/v1", liveModels: false, models: ["org/model"] },
    } };
    expect(routeModel(config, "org/model").providerName).toBe("vendor");
  });
  test("keep-running starts the lightweight proxy before the first Codex process", () => {
    const start = decideCompanionAction({ codexRunning: false, proxyRunning: false, now: 1, stopProxyOnClose: false }, initialCompanionState());
    expect(start.action).toBe("start-proxy");
    expect(start.state.codexLastSeenAt).toBeNull();
    const ready = decideCompanionAction({ codexRunning: false, proxyRunning: true, now: 2, stopProxyOnClose: false }, start.state);
    expect(ready.action).toBe("wait");
  });
  test("V1 pins native and external catalog rows even when an old global V2 flag was observed", () => {
    const entries = ["gpt-6-astra", "google-antigravity/gemini-3.8-flash", "qwen-local/huihui-qwen3.8-27b-abliterated-q6-k-l"]
      .map(slug => ({ slug, multi_agent_version: "v2" }));
    expect(applyMultiAgentMode(entries, "v1", true).every(row => row.multi_agent_version === "v1")).toBe(true);
  });
  test("companion shutdown retains routing and reports preservation separately from deferred teardown", async () => {
    let preserves = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1/api/stop?keep-codex-routing=1"), {
      ownsReceipt: () => false,
      preserveRouting: () => { preserves++; },
      restoreNativeCodex: async () => { throw new Error("must keep the injected endpoint and catalog"); },
      stripGrok: () => { throw new Error("must keep shared routing"); },
    });
    expect(body).toMatchObject({ success: true, sharedTeardown: "preserved" });
    expect(preserves).toBe(1);
  });
});
