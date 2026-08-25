import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256Bytes } from "../src/hash.mjs";
import { tempRoot } from "./temp-root.mjs";
import {
  buildRuntimeManifest,
  verifyRuntimeManifest,
} from "../src/runtime-manifest.mjs";

function contentDigest(files) {
  return sha256Bytes(
    canonicalJson(
      files.map(({ path: filePath, bytes, sha256 }) => ({
        bytes,
        path: filePath,
        sha256,
      })),
    ),
  );
}

async function fixture() {
  const root = await tempRoot("ornith-runtime-");
  const manifestPath = path.join(
    await tempRoot("ornith-runtime-manifest-"),
    "b10099.runtime.json",
  );
  const values = new Map([
    ["dependency.dll", "dependency"],
    ["llama-bench.exe", "bench"],
    ["llama-server.exe", "server"],
  ]);
  const files = [...values]
    .map(([filePath, value]) => ({
      path: filePath,
      bytes: Buffer.byteLength(value),
      sha256: createHash("sha256").update(value).digest("hex"),
      roles: ["test-runtime"],
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  await Promise.all(
    [...values].map(([filePath, value]) =>
      writeFile(path.join(root, filePath), value),
    ),
  );
  const manifest = {
    schema_version: "ornith-runtime-closure-1",
    created_at_utc: "2026-07-24T00:00:00.000Z",
    runtime: {
      project: "ggml-org/llama.cpp",
      release_tag: "b10099",
      commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
      platform: "windows-x86_64",
      cuda_bundle: "13.3",
      root,
    },
    provenance: {
      install_manifest_path: path.join(path.dirname(root), "INSTALL-MANIFEST.json"),
      install_manifest_sha256: "a".repeat(64),
      archives: [
        {
          name: "llama-b10099-bin-win-cuda-13.3-x64.zip",
          url: "https://github.com/ggml-org/llama.cpp/releases/download/b10099/llama-b10099-bin-win-cuda-13.3-x64.zip",
          bytes: 1,
          sha256: "b".repeat(64),
        },
      ],
    },
    entrypoints: {
      llama_bench: "llama-bench.exe",
      llama_server: "llama-server.exe",
    },
    file_set: {
      policy: "exact-flat-files",
      file_count: files.length,
      total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      content_set_sha256: contentDigest(files),
    },
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, bytes);
  return {
    root,
    manifestPath,
    manifest,
    manifestSha256: sha256Bytes(bytes),
    bench: path.join(root, "llama-bench.exe"),
    server: path.join(root, "llama-server.exe"),
  };
}

test("runtime manifest verifies an exact flat content-addressed closure", async () => {
  const value = await fixture();
  const evidence = await verifyRuntimeManifest({
    runtimeRoot: value.root,
    manifestPath: value.manifestPath,
    expectedManifestSha256: value.manifestSha256,
    llamaBench: value.bench,
    llamaServer: value.server,
    expectedReleaseTag: "b10099",
    expectedCommit: value.manifest.runtime.commit,
  });
  assert.equal(evidence.file_count, 3);
  assert.equal(
    evidence.content_set_sha256,
    value.manifest.file_set.content_set_sha256,
  );
  assert.equal(
    evidence.entrypoints.llama_bench.sha256,
    value.manifest.files.find(({ path: name }) => name === "llama-bench.exe")
      .sha256,
  );
});

test("source-built runtime records base, local port, build record, and toolchain evidence", async () => {
  const root = await tempRoot("ornith-source-runtime-");
  const names = [
    "cublas64_13.dll",
    "cublasLt64_13.dll",
    "ggml-base.dll",
    "ggml-cpu.dll",
    "ggml-cuda.dll",
    "ggml.dll",
    "llama-bench-impl.dll",
    "llama-bench.exe",
    "llama-cli-impl.dll",
    "llama-cli.exe",
    "llama-common.dll",
    "llama-server-impl.dll",
    "llama-server.exe",
    "llama.dll",
    "mtmd.dll",
  ];
  await Promise.all(
    names.map((name, index) => writeFile(path.join(root, name), `file-${index}`)),
  );
  const manifest = await buildRuntimeManifest({
    runtimeRoot: root,
    identity: {
      project: "ggml-org/llama.cpp",
      release_tag: "b10099",
      commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
      platform: "windows-x86_64",
      cuda_bundle: "13.3",
    },
    provenance: {
      kind: "source-build",
      base_release_tag: "b10099",
      base_commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
      local_port_commit: "64116480c6c8b3f0d5464ca70f6c730657df9581",
      build_record: {
        path: path.join(path.dirname(root), "ORNITH-MOE-CACHE-BUILD.md"),
        sha256: "a".repeat(64),
      },
      toolchain_evidence: {
        path: path.join(path.dirname(root), "ornith-portable-toolkit-evidence.json"),
        sha256: "b".repeat(64),
      },
    },
  });
  assert.equal(manifest.file_set.file_count, 15);
  assert.equal(manifest.provenance.kind, "source-build");
  assert.equal(
    manifest.provenance.local_port_commit,
    "64116480c6c8b3f0d5464ca70f6c730657df9581",
  );
  assert.equal(
    manifest.provenance.base_commit,
    "1a064ab0921238c1daa397d6f4a900ef33884de2",
  );
});

test("source-built provenance rejects an official archive claim", async () => {
  const root = await tempRoot("ornith-source-runtime-bad-");
  await Promise.all([
    writeFile(path.join(root, "llama-bench.exe"), "bench"),
    writeFile(path.join(root, "llama-server.exe"), "server"),
  ]);
  await assert.rejects(
    buildRuntimeManifest({
      runtimeRoot: root,
      identity: {
        project: "ggml-org/llama.cpp",
        release_tag: "b10099",
        commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
        platform: "windows-x86_64",
        cuda_bundle: "13.3",
      },
      provenance: {
        kind: "source-build",
        base_release_tag: "b10099",
        base_commit: "1a064ab0921238c1daa397d6f4a900ef33884de2",
        local_port_commit: "64116480c6c8b3f0d5464ca70f6c730657df9581",
        build_record: {
          path: path.join(path.dirname(root), "build.md"),
          sha256: "a".repeat(64),
        },
        toolchain_evidence: {
          path: path.join(path.dirname(root), "toolchain.json"),
          sha256: "b".repeat(64),
        },
        archives: [],
      },
    }),
    /RUNTIME_MANIFEST_PROVENANCE_INVALID/,
  );
});

test("runtime closure rejects missing, extra, and changed files", async () => {
  for (const mutation of ["missing", "extra", "changed"]) {
    const value = await fixture();
    if (mutation === "missing") {
      const { unlink } = await import("node:fs/promises");
      await unlink(path.join(value.root, "dependency.dll"));
    } else if (mutation === "extra") {
      await writeFile(path.join(value.root, "surprise.dll"), "extra");
    } else {
      await writeFile(path.join(value.root, "dependency.dll"), "changed");
    }
    await assert.rejects(
      verifyRuntimeManifest({
        runtimeRoot: value.root,
        manifestPath: value.manifestPath,
        expectedManifestSha256: value.manifestSha256,
        llamaBench: value.bench,
        llamaServer: value.server,
        expectedReleaseTag: "b10099",
        expectedCommit: value.manifest.runtime.commit,
      }),
      /RUNTIME_(FILE_SET_MISMATCH|FILE_HASH_MISMATCH|FILE_SIZE_MISMATCH)/,
    );
  }
});

test("runtime manifest pin and configured entrypoints are fail-closed", async () => {
  const value = await fixture();
  await assert.rejects(
    verifyRuntimeManifest({
      runtimeRoot: value.root,
      manifestPath: value.manifestPath,
      expectedManifestSha256: "f".repeat(64),
      llamaBench: value.bench,
      llamaServer: value.server,
      expectedReleaseTag: "b10099",
      expectedCommit: value.manifest.runtime.commit,
    }),
    /RUNTIME_MANIFEST_SHA256_MISMATCH/,
  );
  await assert.rejects(
    verifyRuntimeManifest({
      runtimeRoot: value.root,
      manifestPath: value.manifestPath,
      expectedManifestSha256: value.manifestSha256,
      llamaBench: path.join(path.dirname(value.root), "llama-bench.exe"),
      llamaServer: value.server,
      expectedReleaseTag: "b10099",
      expectedCommit: value.manifest.runtime.commit,
    }),
    /RUNTIME_ENTRYPOINT_PATH_MISMATCH/,
  );
});

test("runtime manifest can never include a GGUF model", async () => {
  const value = await fixture();
  const modelPath = path.join(value.root, "model.gguf");
  await writeFile(modelPath, "model");
  value.manifest.files.push({
    path: "model.gguf",
    bytes: 5,
    sha256: sha256Bytes(Buffer.from("model")),
    roles: ["forbidden"],
  });
  value.manifest.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  value.manifest.file_set.file_count = value.manifest.files.length;
  value.manifest.file_set.total_bytes += 5;
  value.manifest.file_set.content_set_sha256 = contentDigest(
    value.manifest.files,
  );
  const bytes = Buffer.from(`${JSON.stringify(value.manifest, null, 2)}\n`);
  await writeFile(value.manifestPath, bytes);
  await assert.rejects(
    verifyRuntimeManifest({
      runtimeRoot: value.root,
      manifestPath: value.manifestPath,
      expectedManifestSha256: sha256Bytes(bytes),
      llamaBench: value.bench,
      llamaServer: value.server,
      expectedReleaseTag: "b10099",
      expectedCommit: value.manifest.runtime.commit,
    }),
    /RUNTIME_MODEL_FILE_FORBIDDEN/,
  );
});
