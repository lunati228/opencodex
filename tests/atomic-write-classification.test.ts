import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("atomic persistence classification", () => {
  test("both generic atomic publishers are secret-safe primitives", () => {
    const atomicWrite = source("src/config/atomic-write.ts");

    // Upstream consolidated public-cache and credential writes onto the same
    // primitive, now extracted from config.ts. Classification by call-site count
    // is therefore no longer a security boundary; the boundary is the primitive itself.
    // The temp is exclusively created owner-only, identity-checked, then written through
    // the still-open descriptor so a pre-created or swapped path cannot receive the bytes.
    expect(atomicWrite).toContain("constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600");
    expect(atomicWrite).toContain("assertPrivateTempDescriptor(path, descriptor)");
    expect(atomicWrite).toContain('writeFileSync(descriptor, content, { encoding: "utf-8" })');
    expect(atomicWrite).toContain("hardenSecretPath(path, { required: true, timeoutMemoKey })");
    expect(atomicWrite).toContain(
      "await hardenSecretPathAsync(path, { required: true, timeoutMemoKey, retryTimedOutOnce });",
    );
    expect(atomicWrite).toContain("renameAtomicFile");
    expect(atomicWrite).toContain("renameAtomicFileAsync");
    expect(atomicWrite).toContain("AtomicWriteSecretResidualError");
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
