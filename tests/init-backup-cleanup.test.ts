import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOpenAiTierBackupAfterInit } from "../src/cli/init";
import { classifyOpenAiTierBackup, OpenAiTierRollbackPreserveError, preserveOpenAiTierRollbackSnapshot } from "../src/config";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import { setWindowsPrincipalRunnerForTests } from "../src/lib/windows-user-principal";

describe("cleanupOpenAiTierBackupAfterInit", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-init-backup-"));
    dirs.push(dir);
    return dir;
  };
  beforeEach(() => {
    setPlatformForTests("linux");
    resetHardenedStateForTests();
  });
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    setIcaclsRunnerForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setPlatformForTests(null);
    resetHardenedStateForTests();
  });

  test("no-op when no backup exists", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes a stale post-migration (v2) backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, JSON.stringify({ openaiProviderTierVersion: 2, port: 10100, providers: {} }));
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes an unparseable backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, "not-json{{{");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
  });

  test("keeps the authoritative rollback bytes when an existing backup ACL is unverified", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, providers: {} });
    writeFileSync(backup, v1);
    setPlatformForTests("win32");
    setWindowsPrincipalRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "S-1-5-21-1000",
    }));
    setIcaclsRunnerForTests(args => args[0] === backup
      ? { success: false, exitCode: null, timedOut: true, stdout: "" }
      : { success: true, exitCode: 0, timedOut: false, stdout: "" });

    cleanupOpenAiTierBackupAfterInit(configPath);

    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readdirSync(dir).filter(name => name.includes("v1-rollback"))).toEqual([]);
  });

  test("preserves a valid pre-migration (v1) rollback snapshot by renaming it", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    const preserved = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(v1);
  });

  test("does not overwrite an occupied rollback destination (no-replace publication)", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    // Pre-occupy the first-choice destination for the current clock tick(s).
    const now = Date.now();
    const existing = `${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`;
    writeFileSync(existing, "existing rollback");
    const realNow = Date.now;
    Date.now = () => now; // freeze the clock so the collision is deterministic
    try {
      cleanupOpenAiTierBackupAfterInit(configPath);
    } finally {
      Date.now = realNow;
    }
    // The pre-existing snapshot must be untouched, and the v1 backup preserved elsewhere.
    expect(readFileSync(existing, "utf8")).toBe("existing rollback");
    expect(existsSync(backup)).toBe(false);
    const preserved = readdirSync(dir)
      .filter(name => name.includes("pre-openai-tiers-v1-rollback") && join(dir, name) !== existing);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(v1);
  });

  test("classifyOpenAiTierBackup shares the migration policy", () => {
    const enc = (value: string) => new TextEncoder().encode(value);
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 2 })))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc("garbage"))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 1 })))).toBe("rollback");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({})))).toBe("rollback");
  });

  test("preserveOpenAiTierRollbackSnapshot copy failure keeps the v2 backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, {
      exists: existsSync,
      read: path => readFileSync(path),
      copyExclusive: () => { throw new Error("copy failed"); },
      unlink: () => { throw new Error("unlink must not run"); },
    })).toThrow("copy failed");
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot does not overwrite occupied destinations and keeps source on exhaustion", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const now = Date.now();
    writeFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`, "occupied");
    for (let attempt = 1; attempt < 16; attempt++) {
      writeFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}-${attempt}.bak`, "occupied");
    }
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(() => preserveOpenAiTierRollbackSnapshot(configPath)).toThrow(OpenAiTierRollbackPreserveError);
    } finally {
      Date.now = realNow;
    }
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`, "utf8")).toBe("occupied");
    expect(readFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}-1.bak`, "utf8")).toBe("occupied");
  });
});
