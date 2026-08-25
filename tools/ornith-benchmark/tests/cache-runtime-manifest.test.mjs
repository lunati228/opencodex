import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempRoot } from "./temp-root.mjs";

import {
  buildCacheRuntimeManifest,
  CACHE_RUNTIME_CLOSURE,
} from "../src/cache-runtime-manifest.mjs";

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

test("production closure pins the recorded llama-bench implementation hash", () => {
  assert.deepEqual(
    CACHE_RUNTIME_CLOSURE.find(
      ({ path: filePath }) => filePath === "llama-bench-impl.dll",
    ),
    {
      path: "llama-bench-impl.dll",
      bytes: 914_432,
      sha256: "69c5f199601f15eb0bdee57851085dd4d367464f5fdff713f591a7300ba562de",
    },
  );
});

test("production closure pins the repaired cache DLL", () => {
  assert.deepEqual(
    CACHE_RUNTIME_CLOSURE.find(
      ({ path: filePath }) => filePath === "ggml-cuda.dll",
    ),
    {
      path: "ggml-cuda.dll",
      bytes: 51_043_840,
      sha256: "f79564da83e2efeb51e3be8a8ad3d2e56f383d4ffd4a48d12c3b1fedb9fd79b6",
    },
  );
});

test("cache runtime generator binds the exact source-built closure and evidence", async () => {
  const root = await tempRoot("ornith-cache-runtime-");
  const buildRecord = path.join(path.dirname(root), `${path.basename(root)}-build.md`);
  const toolchain = path.join(path.dirname(root), `${path.basename(root)}-toolchain.json`);
  const expectedClosure = [];
  for (let index = 0; index < 15; index += 1) {
    const name =
      index === 0
        ? "llama-bench.exe"
        : index === 1
          ? "llama-server.exe"
          : `dependency-${String(index).padStart(2, "0")}.dll`;
    const bytes = Buffer.from(`runtime-${index}`);
    await writeFile(path.join(root, name), bytes);
    expectedClosure.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(buildRecord, "build evidence");
  await writeFile(toolchain, "toolchain evidence");

  const manifest = await buildCacheRuntimeManifest({
    runtimeRoot: root,
    buildRecord: {
      path: buildRecord,
      sha256: sha256("build evidence"),
    },
    toolchainEvidence: {
      path: toolchain,
      sha256: sha256("toolchain evidence"),
    },
    expectedClosure,
  });

  assert.equal(manifest.file_set.file_count, 15);
  assert.equal(manifest.provenance.kind, "source-build");
  assert.equal(
    manifest.runtime.commit,
    "1a064ab0921238c1daa397d6f4a900ef33884de2",
  );
  assert.equal(
    manifest.provenance.base_commit,
    "1a064ab0921238c1daa397d6f4a900ef33884de2",
  );
  assert.equal(
    manifest.provenance.local_port_commit,
    "3f7eadbec435e43706ea0798810cab471d982bea",
  );
  assert.notEqual(
    manifest.runtime.commit,
    manifest.provenance.local_port_commit,
    "embedded --version identity is distinct from the later source snapshot commit",
  );
});

test("cache runtime generator rejects changed evidence before manifesting", async () => {
  const root = await tempRoot("ornith-cache-runtime-bad-");
  const buildRecord = path.join(path.dirname(root), `${path.basename(root)}-build.md`);
  const toolchain = path.join(path.dirname(root), `${path.basename(root)}-toolchain.json`);
  await Promise.all([
    writeFile(path.join(root, "llama-bench.exe"), "bench"),
    writeFile(path.join(root, "llama-server.exe"), "server"),
    writeFile(buildRecord, "changed"),
    writeFile(toolchain, "toolchain"),
  ]);
  await assert.rejects(
    buildCacheRuntimeManifest({
      runtimeRoot: root,
      buildRecord: { path: buildRecord, sha256: "a".repeat(64) },
      toolchainEvidence: { path: toolchain, sha256: sha256("toolchain") },
      expectedClosure: [
        { path: "llama-bench.exe", bytes: 5, sha256: sha256("bench") },
        { path: "llama-server.exe", bytes: 6, sha256: sha256("server") },
      ],
    }),
    /SOURCE_BUILD_EVIDENCE_HASH_MISMATCH: build_record/,
  );
});
