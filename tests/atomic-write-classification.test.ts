import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("atomic persistence classification", () => {
  test("both generic atomic publishers are secret-safe primitives", () => {
    const config = source("src/config.ts");

    // Upstream consolidated public-cache and credential writes onto the same
    // primitive. Classification by call-site count is therefore no longer a
    // security boundary; the boundary is the primitive itself.
    expect(config).toContain('writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 })');
    expect(config).toContain("hardenSecretPath(target, { required: true, timeoutMemoKey: path })");
    expect(config).toContain("hardenSecretPathAsync(target, {");
    expect(config).toContain("required: true,");
    expect(config).toContain("timeoutMemoKey: path,");
    expect(config).toContain("renameAtomicFile");
    expect(config).toContain("renameAtomicFileAsync");
    expect(config).toContain("AtomicWriteSecretResidualError");
  });

  test("credential-bearing fork surfaces retain a hardened atomic publisher", () => {
    const contracts = [
      ["src/responses/state.ts", "atomicWriteFileAsync("],
      ["src/codex/history-provider.ts", "atomicWriteSecretFile("],
      ["src/claude/desktop-3p.ts", "atomicWriteFile("],
      ["src/grok/inject.ts", "atomicWriteSecretFile("],
      ["src/oauth/store.ts", "atomicWriteFileAsync("],
    ] as const;

    for (const [relativePath, publisher] of contracts) {
      expect(source(relativePath), relativePath).toContain(publisher);
    }

    // The two external-home writers still harden their exact parent directory;
    // the OAuth store instead owns a serialized one-shot ACL recovery.
    expect(source("src/codex/history-provider.ts")).toContain("hardenDirectoryForSecretWrite(");
    expect(source("src/grok/inject.ts")).toContain("hardenDirectoryForSecretWrite(");
    expect(source("src/oauth/store.ts")).toContain("{ retryTimedOutOnce: true }");
  });
});
