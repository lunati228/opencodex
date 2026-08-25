import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Bytes } from "./hash.mjs";

const SCHEMA = "ornith-runtime-closure-1";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_FILES = 256;
const SHA256 = /^[a-f0-9]{64}$/;

function runtimeError(code, detail, cause) {
  const error = new Error(detail ? `${code}: ${detail}` : code, { cause });
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validEvidenceFile(value) {
  return (
    exactKeys(value, ["path", "sha256"]) &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    SHA256.test(value.sha256)
  );
}

function validOfficialArchiveProvenance(provenance) {
  return (
    exactKeys(provenance, [
      "install_manifest_path",
      "install_manifest_sha256",
      "archives",
    ]) &&
    typeof provenance.install_manifest_path === "string" &&
    path.isAbsolute(provenance.install_manifest_path) &&
    SHA256.test(provenance.install_manifest_sha256) &&
    Array.isArray(provenance.archives) &&
    provenance.archives.length > 0 &&
    provenance.archives.every(
      (archive) =>
        exactKeys(archive, ["name", "url", "bytes", "sha256"]) &&
        typeof archive.name === "string" &&
        archive.url.startsWith(
          "https://github.com/ggml-org/llama.cpp/releases/download/",
        ) &&
        Number.isSafeInteger(archive.bytes) &&
        archive.bytes > 0 &&
        SHA256.test(archive.sha256),
    )
  );
}

function validSourceBuildProvenance(provenance) {
  return (
    exactKeys(provenance, [
      "kind",
      "base_release_tag",
      "base_commit",
      "local_port_commit",
      "build_record",
      "toolchain_evidence",
    ]) &&
    provenance.kind === "source-build" &&
    /^b[0-9]+$/.test(provenance.base_release_tag) &&
    /^[a-f0-9]{40}$/.test(provenance.base_commit) &&
    /^[a-f0-9]{40}$/.test(provenance.local_port_commit) &&
    provenance.local_port_commit !== provenance.base_commit &&
    validEvidenceFile(provenance.build_record) &&
    validEvidenceFile(provenance.toolchain_evidence)
  );
}

async function assertNoReparseComponents(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw runtimeError("RUNTIME_PATH_NOT_ABSOLUTE", String(filePath));
  }
  const resolved = path.resolve(filePath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw runtimeError("RUNTIME_REPARSE_POINT_REJECTED", cursor);
    }
  }
}

async function readStableBoundedFile(filePath, maximumBytes) {
  await assertNoReparseComponents(filePath);
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw runtimeError("RUNTIME_MANIFEST_SIZE_INVALID", filePath);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== before.size
    ) {
      throw runtimeError("RUNTIME_FILE_CHANGED_DURING_READ", filePath);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashStableFile(filePath, expectedBytes) {
  const handle = await open(filePath, "r");
  let before;
  let digest;
  try {
    before = await handle.stat();
    if (!before.isFile()) {
      throw runtimeError("RUNTIME_ENTRY_NOT_FILE", filePath);
    }
    if (before.size !== expectedBytes) {
      throw runtimeError(
        "RUNTIME_FILE_SIZE_MISMATCH",
        `${filePath}: expected=${expectedBytes} actual=${before.size}`,
      );
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw runtimeError("RUNTIME_FILE_CHANGED_DURING_HASH", filePath);
    }
    digest = hash.digest("hex");
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(filePath);
  if (
    pathAfter.isSymbolicLink() ||
    !pathAfter.isFile() ||
    pathAfter.dev !== before.dev ||
    pathAfter.ino !== before.ino ||
    pathAfter.size !== before.size ||
    pathAfter.mtimeMs !== before.mtimeMs ||
    pathAfter.ctimeMs !== before.ctimeMs
  ) {
    throw runtimeError("RUNTIME_FILE_PATH_CHANGED_DURING_HASH", filePath);
  }
  return digest;
}

function validateSafeFlatName(name) {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(":") ||
    name.includes("\0")
  ) {
    throw runtimeError("RUNTIME_MANIFEST_PATH_INVALID", String(name));
  }
  if (name.toLowerCase().endsWith(".gguf")) {
    throw runtimeError("RUNTIME_MODEL_FILE_FORBIDDEN", name);
  }
}

async function exactFlatFiles(runtimeRoot) {
  await assertNoReparseComponents(runtimeRoot);
  const rootMetadata = await lstat(runtimeRoot);
  if (!rootMetadata.isDirectory()) {
    throw runtimeError("RUNTIME_ROOT_NOT_DIRECTORY", runtimeRoot);
  }
  const physicalRoot = await realpath(runtimeRoot);
  if (!samePath(physicalRoot, runtimeRoot)) {
    throw runtimeError("RUNTIME_ROOT_PHYSICAL_PATH_MISMATCH", runtimeRoot);
  }
  const entries = (await readdir(runtimeRoot, { withFileTypes: true })).sort(
    (left, right) => ordinal(left.name, right.name),
  );
  if (entries.length < 1 || entries.length > MAX_RUNTIME_FILES) {
    throw runtimeError("RUNTIME_FILE_COUNT_INVALID", String(entries.length));
  }
  for (const entry of entries) {
    validateSafeFlatName(entry.name);
    if (entry.isSymbolicLink()) {
      throw runtimeError(
        "RUNTIME_REPARSE_POINT_REJECTED",
        path.join(runtimeRoot, entry.name),
      );
    }
    if (!entry.isFile()) {
      throw runtimeError("RUNTIME_NOT_FLAT", entry.name);
    }
  }
  return entries.map(({ name }) => name);
}

function validateManifestShape(manifest) {
  if (
    !exactKeys(manifest, [
      "schema_version",
      "created_at_utc",
      "runtime",
      "provenance",
      "entrypoints",
      "file_set",
      "files",
    ]) ||
    manifest.schema_version !== SCHEMA ||
    !Number.isFinite(new Date(manifest.created_at_utc).getTime())
  ) {
    throw runtimeError("RUNTIME_MANIFEST_SCHEMA_INVALID");
  }
  if (
    !exactKeys(manifest.runtime, [
      "project",
      "release_tag",
      "commit",
      "platform",
      "cuda_bundle",
      "root",
    ]) ||
    manifest.runtime.project !== "ggml-org/llama.cpp" ||
    manifest.runtime.platform !== "windows-x86_64" ||
    manifest.runtime.cuda_bundle !== "13.3" ||
    !/^b[0-9]+$/.test(manifest.runtime.release_tag) ||
    !/^[a-f0-9]{40}$/.test(manifest.runtime.commit) ||
    typeof manifest.runtime.root !== "string" ||
    !path.isAbsolute(manifest.runtime.root)
  ) {
    throw runtimeError("RUNTIME_MANIFEST_IDENTITY_INVALID");
  }
  if (
    !validOfficialArchiveProvenance(manifest.provenance) &&
    !validSourceBuildProvenance(manifest.provenance)
  ) {
    throw runtimeError("RUNTIME_MANIFEST_PROVENANCE_INVALID");
  }
  if (
    manifest.provenance.kind === "source-build" &&
    (manifest.provenance.base_release_tag !== manifest.runtime.release_tag ||
      manifest.provenance.base_commit !== manifest.runtime.commit ||
      manifest.provenance.local_port_commit === manifest.runtime.commit)
  ) {
    throw runtimeError("RUNTIME_MANIFEST_PROVENANCE_IDENTITY_MISMATCH");
  }
  if (
    !exactKeys(manifest.entrypoints, ["llama_bench", "llama_server"]) ||
    manifest.entrypoints.llama_bench !== "llama-bench.exe" ||
    manifest.entrypoints.llama_server !== "llama-server.exe"
  ) {
    throw runtimeError("RUNTIME_MANIFEST_ENTRYPOINT_INVALID");
  }
  if (
    !exactKeys(manifest.file_set, [
      "policy",
      "file_count",
      "total_bytes",
      "content_set_sha256",
    ]) ||
    manifest.file_set.policy !== "exact-flat-files" ||
    !Number.isSafeInteger(manifest.file_set.file_count) ||
    manifest.file_set.file_count < 1 ||
    manifest.file_set.file_count > MAX_RUNTIME_FILES ||
    !Number.isSafeInteger(manifest.file_set.total_bytes) ||
    manifest.file_set.total_bytes < 1 ||
    !SHA256.test(manifest.file_set.content_set_sha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.file_set.file_count
  ) {
    throw runtimeError("RUNTIME_MANIFEST_FILE_SET_INVALID");
  }
  const seen = new Set();
  let prior = null;
  for (const file of manifest.files) {
    if (
      !exactKeys(file, ["path", "bytes", "sha256", "roles"]) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      !SHA256.test(file.sha256) ||
      !Array.isArray(file.roles) ||
      file.roles.some(
        (role) => typeof role !== "string" || role.length < 1 || role.length > 80,
      )
    ) {
      throw runtimeError("RUNTIME_MANIFEST_FILE_INVALID");
    }
    validateSafeFlatName(file.path);
    const folded = file.path.toLowerCase();
    if (seen.has(folded) || (prior !== null && ordinal(prior, file.path) >= 0)) {
      throw runtimeError("RUNTIME_MANIFEST_FILE_ORDER_INVALID", file.path);
    }
    seen.add(folded);
    prior = file.path;
  }
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const projection = manifest.files.map(({ path: filePath, bytes, sha256 }) => ({
    bytes,
    path: filePath,
    sha256,
  }));
  if (
    totalBytes !== manifest.file_set.total_bytes ||
    sha256Bytes(canonicalJson(projection)) !==
      manifest.file_set.content_set_sha256
  ) {
    throw runtimeError("RUNTIME_MANIFEST_CONTENT_SET_INVALID");
  }
}

async function inventoryFiles(runtimeRoot, names, rolesForFile = () => []) {
  const files = [];
  for (const name of names) {
    const filePath = path.join(runtimeRoot, name);
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw runtimeError("RUNTIME_ENTRY_NOT_FILE", name);
    }
    const sha256 = await hashStableFile(filePath, metadata.size);
    const roles = rolesForFile(name);
    if (
      !Array.isArray(roles) ||
      roles.some((role) => typeof role !== "string" || role.length < 1)
    ) {
      throw runtimeError("RUNTIME_ROLE_INVALID", name);
    }
    files.push({ path: name, bytes: metadata.size, sha256, roles });
  }
  return files;
}

export async function buildRuntimeManifest({
  runtimeRoot,
  identity,
  provenance,
  entrypoints = {
    llama_bench: "llama-bench.exe",
    llama_server: "llama-server.exe",
  },
  rolesForFile,
  createdAt = new Date().toISOString(),
}) {
  const names = await exactFlatFiles(runtimeRoot);
  const files = await inventoryFiles(runtimeRoot, names, rolesForFile);
  const projection = files.map(({ path: filePath, bytes, sha256 }) => ({
    bytes,
    path: filePath,
    sha256,
  }));
  const manifest = {
    schema_version: SCHEMA,
    created_at_utc: createdAt,
    runtime: {
      project: identity.project,
      release_tag: identity.release_tag,
      commit: identity.commit,
      platform: identity.platform,
      cuda_bundle: identity.cuda_bundle,
      root: path.resolve(runtimeRoot),
    },
    provenance: structuredClone(provenance),
    entrypoints: structuredClone(entrypoints),
    file_set: {
      policy: "exact-flat-files",
      file_count: files.length,
      total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      content_set_sha256: sha256Bytes(canonicalJson(projection)),
    },
    files,
  };
  validateManifestShape(manifest);
  return manifest;
}

export async function verifyRuntimeManifest({
  runtimeRoot,
  manifestPath,
  expectedManifestSha256,
  llamaBench,
  llamaServer,
  expectedReleaseTag,
  expectedCommit,
}) {
  if (!SHA256.test(expectedManifestSha256 ?? "")) {
    throw runtimeError("RUNTIME_MANIFEST_SHA256_INVALID");
  }
  if (!path.isAbsolute(runtimeRoot) || !path.isAbsolute(manifestPath)) {
    throw runtimeError("RUNTIME_PATH_NOT_ABSOLUTE");
  }
  if (samePath(runtimeRoot, manifestPath)) {
    throw runtimeError("RUNTIME_MANIFEST_INSIDE_RUNTIME_ROOT");
  }
  const manifestRelative = path.relative(path.resolve(runtimeRoot), path.resolve(manifestPath));
  if (
    manifestRelative === "" ||
    (!manifestRelative.startsWith(`..${path.sep}`) &&
      manifestRelative !== ".." &&
      !path.isAbsolute(manifestRelative))
  ) {
    throw runtimeError("RUNTIME_MANIFEST_INSIDE_RUNTIME_ROOT");
  }
  const manifestBytes = await readStableBoundedFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
  );
  const manifestSha256 = sha256Bytes(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256.toLowerCase()) {
    throw runtimeError("RUNTIME_MANIFEST_SHA256_MISMATCH");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch (error) {
    throw runtimeError("RUNTIME_MANIFEST_JSON_INVALID", error.message, error);
  }
  validateManifestShape(manifest);
  if (
    !samePath(manifest.runtime.root, runtimeRoot) ||
    manifest.runtime.release_tag !== expectedReleaseTag ||
    manifest.runtime.commit !== expectedCommit
  ) {
    throw runtimeError("RUNTIME_MANIFEST_IDENTITY_MISMATCH");
  }
  for (const [configured, entrypoint] of [
    [llamaBench, manifest.entrypoints.llama_bench],
    [llamaServer, manifest.entrypoints.llama_server],
  ]) {
    if (
      typeof configured !== "string" ||
      !samePath(configured, path.join(runtimeRoot, entrypoint))
    ) {
      throw runtimeError("RUNTIME_ENTRYPOINT_PATH_MISMATCH", String(configured));
    }
  }
  const namesBefore = await exactFlatFiles(runtimeRoot);
  const expectedNames = manifest.files.map(({ path: filePath }) => filePath);
  if (
    namesBefore.length !== expectedNames.length ||
    namesBefore.some(
      (name, index) => name.toLowerCase() !== expectedNames[index].toLowerCase(),
    )
  ) {
    throw runtimeError("RUNTIME_FILE_SET_MISMATCH");
  }
  const actualFiles = [];
  for (const expected of manifest.files) {
    const filePath = path.join(runtimeRoot, expected.path);
    const actualSha256 = await hashStableFile(filePath, expected.bytes);
    if (actualSha256 !== expected.sha256) {
      throw runtimeError("RUNTIME_FILE_HASH_MISMATCH", expected.path);
    }
    actualFiles.push({ ...expected, sha256: actualSha256 });
  }
  const namesAfter = await exactFlatFiles(runtimeRoot);
  if (
    namesAfter.length !== namesBefore.length ||
    namesAfter.some((name, index) => name !== namesBefore[index])
  ) {
    throw runtimeError("RUNTIME_FILE_SET_CHANGED_DURING_VERIFICATION");
  }
  const projection = actualFiles.map(({ path: filePath, bytes, sha256 }) => ({
    bytes,
    path: filePath,
    sha256,
  }));
  const contentSetSha256 = sha256Bytes(canonicalJson(projection));
  if (contentSetSha256 !== manifest.file_set.content_set_sha256) {
    throw runtimeError("RUNTIME_CONTENT_SET_SHA256_MISMATCH");
  }
  const byName = new Map(actualFiles.map((file) => [file.path, file]));
  return {
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    runtime_root: runtimeRoot,
    file_count: actualFiles.length,
    total_bytes: manifest.file_set.total_bytes,
    content_set_sha256: contentSetSha256,
    identity: structuredClone(manifest.runtime),
    provenance: structuredClone(manifest.provenance),
    entrypoints: {
      llama_bench: structuredClone(
        byName.get(manifest.entrypoints.llama_bench),
      ),
      llama_server: structuredClone(
        byName.get(manifest.entrypoints.llama_server),
      ),
    },
  };
}
