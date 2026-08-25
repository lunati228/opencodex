import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPreflight } from "../src/preflight.mjs";
import { tempRoot } from "./temp-root.mjs";

test("preflight rejects placeholders before touching large artifacts", async () => {
  await assert.rejects(
    runPreflight({
      llama_bench: "<LLAMA_BENCH_EXE>",
      llama_server: "<LLAMA_SERVER_EXE>",
      model: "<MODEL_GGUF>",
      quality_manifest: "<QUALITY_MANIFEST>",
    }),
    /UNRESOLVED_PLACEHOLDER/,
  );
});

test("preflight rejects missing binaries, model, or fixture manifest", async () => {
  await assert.rejects(
    runPreflight({
      llama_bench: "Z:\\missing\\llama-bench.exe",
      llama_server: "Z:\\missing\\llama-server.exe",
      model: "Z:\\missing\\model.gguf",
      quality_manifest: "Z:\\missing\\manifest.json",
    }),
    /MISSING_REQUIRED_PATH/,
  );
});

test("preflight validates a complete tiny offline test configuration", async () => {
  const root = await tempRoot("ornith-preflight-");
  const bench = path.join(root, "llama-bench.exe");
  const server = path.join(root, "llama-server.exe");
  const model = path.join(root, "model.gguf");
  const quality = path.join(root, "manifest.json");
  await Promise.all([
    writeFile(bench, "bench"),
    writeFile(server, "server"),
    writeFile(model, "tiny-test-model"),
    writeFile(quality, '{"id":"fixture"}'),
  ]);

  const result = await runPreflight({
    llama_bench: bench,
    llama_server: server,
    model,
    quality_manifest: quality,
    expected: {
      model_bytes: 15,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.node_major, 24);
  assert.equal(result.paths.model.bytes, 15);
});

test("normal preflight trusts pinned install-manifest evidence without rehashing model", async () => {
  const root = await tempRoot("ornith-manifest-preflight-");
  const bench = path.join(root, "llama-bench.exe");
  const server = path.join(root, "llama-server.exe");
  const model = path.join(root, "model.gguf");
  const quality = path.join(root, "quality.json");
  const installManifest = path.join(root, "INSTALL-MANIFEST.json");
  await Promise.all([
    writeFile(bench, "bench"),
    writeFile(server, "server"),
    writeFile(model, "tiny-test-model"),
    writeFile(quality, '{"id":"fixture"}'),
  ]);
  const evidence = {
    createdAt: "2026-07-24T07:38:12.448Z",
    repository: { immutableRevision: "revision-test" },
    installDirectory: root,
    files: [
      {
        name: "model.gguf",
        bytes: 15,
        sha256: "a".repeat(64),
        expectedBytesMatch: true,
        expectedSHA256Match: true,
      },
    ],
  };
  await writeFile(installManifest, JSON.stringify(evidence));
  const { createHash } = await import("node:crypto");
  const manifestSha = createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");

  const result = await runPreflight({
    llama_bench: bench,
    llama_server: server,
    model,
    quality_manifest: quality,
    install_manifest: installManifest,
    expected: {
      model_bytes: 15,
      model_sha256: "a".repeat(64),
      install_manifest_sha256: manifestSha,
      revision: "revision-test",
    },
  });
  assert.equal(result.paths.model.sha256, undefined);
  assert.equal(result.hash_evidence.source, "INSTALL-MANIFEST.json");
  assert.equal(result.hash_evidence.model_sha256, "a".repeat(64));
});
