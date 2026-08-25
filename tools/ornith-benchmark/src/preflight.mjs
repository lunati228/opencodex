import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./hash.mjs";
import { verifyRuntimeManifest } from "./runtime-manifest.mjs";

function hasPlaceholder(value) {
  if (typeof value === "string") {
    return /<[^>]+>|\$\{[^}]+\}/.test(value);
  }
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasPlaceholder);
  }
  return false;
}

async function inspectRequiredPath(name, filePath) {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`MISSING_REQUIRED_PATH: ${name}=${filePath}`);
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`REQUIRED_PATH_NOT_FILE: ${name}=${filePath}`);
  }
  return { path: filePath, bytes: metadata.size };
}

export async function runPreflight(
  config,
  { hashFiles = false, hashBinaries = false } = {},
) {
  if (!config || typeof config !== "object" || hasPlaceholder(config)) {
    throw new Error("UNRESOLVED_PLACEHOLDER");
  }
  const required = [
    ["llama_bench", config.llama_bench],
    ["llama_server", config.llama_server],
    ["model", config.model],
    ["quality_manifest", config.quality_manifest],
  ];
  if (config.expected?.install_manifest_sha256) {
    required.push(["install_manifest", config.install_manifest]);
  }
  if (config.runtime_manifest !== undefined) {
    required.push(["runtime_manifest", config.runtime_manifest]);
  }
  if (config.live) {
    required.push(
      ["nvidia_smi", config.live.nvidia_smi],
      ["host_monitor", config.live.host_monitor],
    );
  }
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`MISSING_REQUIRED_CONFIG: ${name}`);
    }
  }

  const paths = {};
  for (const [name, filePath] of required) {
    paths[name] = await inspectRequiredPath(name, filePath);
  }
  const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
  if (nodeMajor !== 24) {
    throw new Error(`UNSUPPORTED_NODE_MAJOR: ${nodeMajor}`);
  }
  if (
    config.expected?.model_bytes !== undefined &&
    paths.model.bytes !== config.expected.model_bytes
  ) {
    throw new Error(
      `MODEL_SIZE_MISMATCH: expected=${config.expected.model_bytes} actual=${paths.model.bytes}`,
    );
  }
  let runtimeEvidence = null;
  if (config.runtime_manifest !== undefined) {
    runtimeEvidence = await verifyRuntimeManifest({
      runtimeRoot: config.runtime_root,
      manifestPath: config.runtime_manifest,
      expectedManifestSha256:
        config.expected?.runtime_manifest_sha256,
      llamaBench: config.llama_bench,
      llamaServer: config.llama_server,
      expectedReleaseTag: config.candidate?.llama_tag,
      expectedCommit: config.candidate?.llama_commit,
    });
    paths.llama_bench.sha256 =
      runtimeEvidence.entrypoints.llama_bench.sha256;
    paths.llama_server.sha256 =
      runtimeEvidence.entrypoints.llama_server.sha256;
    paths.runtime_manifest.sha256 = runtimeEvidence.manifest_sha256;
  }
  let hashEvidence = null;
  if (config.expected?.install_manifest_sha256) {
    paths.install_manifest.sha256 = await sha256File(paths.install_manifest.path);
    if (
      paths.install_manifest.sha256 !==
      config.expected.install_manifest_sha256.toLowerCase()
    ) {
      throw new Error("INSTALL_MANIFEST_SHA256_MISMATCH");
    }
    const manifest = JSON.parse(
      await readFile(paths.install_manifest.path, "utf8"),
    );
    const recordedAt = new Date(manifest.createdAt);
    if (!Number.isFinite(recordedAt.getTime())) {
      throw new Error("INVALID_HASH_EVIDENCE_TIMESTAMP");
    }
    const modelEntry = manifest.files?.find(
      ({ name }) => name === path.basename(config.model),
    );
    if (!modelEntry) throw new Error("MODEL_MISSING_FROM_INSTALL_MANIFEST");
    const recordedModelPath = path.resolve(
      manifest.installDirectory,
      modelEntry.name,
    );
    const expectedModelPath = path.resolve(config.model);
    const samePath =
      process.platform === "win32"
        ? recordedModelPath.toLowerCase() === expectedModelPath.toLowerCase()
        : recordedModelPath === expectedModelPath;
    if (!samePath) throw new Error("MODEL_PATH_MANIFEST_MISMATCH");
    if (
      modelEntry.bytes !== paths.model.bytes ||
      modelEntry.expectedBytesMatch !== true
    ) {
      throw new Error("MODEL_SIZE_MANIFEST_MISMATCH");
    }
    if (
      !/^[a-f0-9]{64}$/.test(modelEntry.sha256) ||
      modelEntry.expectedSHA256Match !== true
    ) {
      throw new Error("MODEL_HASH_EVIDENCE_INVALID");
    }
    if (
      config.expected?.model_sha256 &&
      modelEntry.sha256 !== config.expected.model_sha256.toLowerCase()
    ) {
      throw new Error("MODEL_SHA256_MANIFEST_MISMATCH");
    }
    if (
      config.expected?.revision &&
      manifest.repository?.immutableRevision !== config.expected.revision
    ) {
      throw new Error("REVISION_MANIFEST_MISMATCH");
    }
    hashEvidence = {
      source: "INSTALL-MANIFEST.json",
      manifest_sha256: paths.install_manifest.sha256,
      recorded_at_utc: recordedAt.toISOString(),
      model_path: recordedModelPath,
      model_bytes: modelEntry.bytes,
      model_sha256: modelEntry.sha256,
      revision: manifest.repository?.immutableRevision ?? null,
    };
  }
  if (hashFiles) {
    for (const [name] of required) {
      paths[name].sha256 ??= await sha256File(paths[name].path);
    }
  }
  if (hashBinaries && !hashFiles) {
    for (const name of ["llama_bench", "llama_server"]) {
      paths[name].sha256 ??= await sha256File(paths[name].path);
    }
  }
  for (const [name, expectedName] of [
    ["llama_bench", "bench_sha256"],
    ["llama_server", "server_sha256"],
  ]) {
    if (
      (hashFiles || hashBinaries) &&
      config.expected?.[expectedName] &&
      paths[name].sha256 !== config.expected[expectedName].toLowerCase()
    ) {
      throw new Error(`${expectedName.toUpperCase()}_MISMATCH`);
    }
  }
  if (
    hashFiles &&
    config.expected?.model_sha256 &&
    paths.model.sha256 !== config.expected.model_sha256.toLowerCase()
  ) {
    throw new Error("MODEL_SHA256_MISMATCH");
  }
  return {
    ok: true,
    node_major: nodeMajor,
    checked_at_utc: new Date().toISOString(),
    paths,
    hash_evidence: hashEvidence,
    runtime_evidence: runtimeEvidence,
  };
}
