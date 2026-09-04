import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const isolatedCodexHome = mkdtempSync(join(tmpdir(), "ocx-config-codex-home-"));

setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: isolatedCodexHome, ...env },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
}

function freshConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  const config = {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      blsc: {
        adapter: "openai-chat",
        baseUrl: "https://llmapi.blsc.cn",
        modelCosts: {
          "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          "sk-abcdef1234567890": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        },
      },
    },
    defaultProvider: "openai",
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("ocx config display redaction", () => {
  test("config show --json never prints secret-shaped modelCosts keys", () => {
    const dir = freshConfig();
    try {
      const result = runCli(["config", "show", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-abcdef1234567890");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.providers.blsc.modelCosts).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("config get providers.<name>.modelCosts --json drops secret-shaped keys", () => {
    const dir = freshConfig();
    try {
      const result = runCli(["config", "get", "providers.blsc.modelCosts", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-abcdef1234567890");
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});

describe("ocx config export", () => {
  test("exports an importable persisted view without runtime-managed provider projections", () => {
    const dir = freshConfig();
    const importDir = mkdtempSync(join(tmpdir(), "ocx-config-import-"));
    try {
      const configPath = join(dir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.externalProviderBundles = ["nvidia-glm-5.2"];
      config.localRuntime = {
        enabled: true,
        autoStart: false,
        profileId: "qwen38-27b-q6kl",
        nCtx: 131_072,
        reasoningEffort: "medium",
      };
      writeFileSync(configPath, JSON.stringify(config), "utf8");

      const exportPath = join(dir, "export.json");
      const isolatedEnv = {
        OPENCODEX_HOME: dir,
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: join(dir, "AppData", "Roaming"),
        LOCALAPPDATA: join(dir, "AppData", "Local"),
      };
      const exported = runCli(["config", "export", exportPath], isolatedEnv);
      expect(exported.status).toBe(0);

      const payload = JSON.parse(readFileSync(exportPath, "utf8"));
      expect(payload.externalProviderBundles).toEqual(["nvidia-glm-5.2"]);
      expect(payload.localRuntime).toEqual(config.localRuntime);
      expect(payload.providers["nvidia-glm-5.2"]).toBeUndefined();
      expect(payload.providers["qwen-local"]).toBeUndefined();

      const validated = runCli(["config", "validate", exportPath, "--json"], isolatedEnv);
      expect(validated.status).toBe(0);
      const imported = runCli(["config", "import", exportPath, "--yes", "--json"], {
        ...isolatedEnv,
        OPENCODEX_HOME: importDir,
      });
      expect(imported.status).toBe(0);
    } finally {
      removeTreeWithRetry(dir);
      removeTreeWithRetry(importDir);
    }
  });

  test("config set strips runtime-managed provider projections before validation", () => {
    const dir = freshConfig();
    try {
      const configPath = join(dir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.externalProviderBundles = ["nvidia-glm-5.2"];
      config.localRuntime = {
        enabled: true,
        autoStart: false,
        profileId: "qwen38-27b-q6kl",
        nCtx: 131_072,
        reasoningEffort: "medium",
      };
      writeFileSync(configPath, JSON.stringify(config), "utf8");

      const result = runCli(
        ["config", "set", "localRuntime.nCtx", "184320", "--json"],
        { OPENCODEX_HOME: dir },
      );
      expect(result.status).toBe(0);
      const persisted = JSON.parse(readFileSync(configPath, "utf8"));
      expect(persisted.localRuntime.nCtx).toBe(184_320);
      expect(persisted.providers["qwen-local"]).toBeUndefined();
      expect(persisted.providers["nvidia-glm-5.2"]).toBeUndefined();
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
