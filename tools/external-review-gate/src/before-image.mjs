import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  isPathInside,
  sha256,
} from "./canonical.mjs";

const MANIFEST_KEYS = [
  "schemaVersion",
  "createdAtMs",
  "settingsPath",
  "backupPath",
  "byteLength",
  "contentSha256",
  "hmacSha256",
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export async function createBeforeImage({
  settingsPath,
  backupDirectory,
  manifestPath,
  manifestKey,
  now = Date.now,
  random = randomBytes,
}) {
  if (!Buffer.isBuffer(manifestKey) || manifestKey.length < 32) {
    throw new Error("before-image HMAC key must be at least 32 bytes");
  }
  const source = await realpath(settingsPath);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("settings before-image source must be a regular non-symlink file");
  }
  const bytes = await readFile(source);
  const backupRoot = path.resolve(backupDirectory);
  await mkdir(backupRoot, { recursive: true });
  const canonicalBackupRoot = await realpath(backupRoot);
  const createdAtMs = now();
  const backupPath = path.join(
    canonicalBackupRoot,
    `settings-${createdAtMs}-${random(8).toString("hex")}.bin`,
  );
  await writeFile(backupPath, bytes, { flag: "wx", mode: 0o600 });
  const unsigned = {
    schemaVersion: 1,
    createdAtMs,
    settingsPath: source,
    backupPath,
    byteLength: bytes.length,
    contentSha256: sha256(bytes),
  };
  const manifest = {
    ...unsigned,
    hmacSha256: createHmac("sha256", manifestKey)
      .update(canonicalJson(unsigned), "utf8")
      .digest("hex"),
  };
  const targetManifest = path.resolve(manifestPath);
  await mkdir(path.dirname(targetManifest), { recursive: true });
  await writeFile(targetManifest, JSON.stringify(manifest, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return Object.freeze(manifest);
}

export async function restoreBeforeImage({
  manifestPath,
  expectedSettingsPath,
  expectedBackupDirectory,
  manifestKey,
  random = randomBytes,
}) {
  if (!Buffer.isBuffer(manifestKey) || manifestKey.length < 32) {
    throw new Error("before-image HMAC key must be at least 32 bytes");
  }
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  if (
    !exactKeys(manifest, MANIFEST_KEYS) ||
    manifest.schemaVersion !== 1 ||
    !Number.isSafeInteger(manifest.byteLength) ||
    manifest.byteLength < 0 ||
    !/^[0-9a-f]{64}$/.test(manifest.contentSha256)
  ) {
    throw new Error("before-image manifest is invalid");
  }
  const { hmacSha256, ...unsigned } = manifest;
  const expectedHmac = createHmac("sha256", manifestKey)
    .update(canonicalJson(unsigned), "utf8")
    .digest("hex");
  if (
    !/^[0-9a-f]{64}$/.test(hmacSha256) ||
    !timingSafeEqual(
      Buffer.from(hmacSha256, "hex"),
      Buffer.from(expectedHmac, "hex"),
    )
  ) {
    throw new Error("before-image manifest HMAC mismatch");
  }
  const backupPath = path.resolve(manifest.backupPath);
  const expectedTargetInput = path.resolve(expectedSettingsPath);
  const expectedTarget = path.join(
    await realpath(path.dirname(expectedTargetInput)),
    path.basename(expectedTargetInput),
  );
  const expectedBackupRoot = await realpath(expectedBackupDirectory);
  const canonicalBackupPath = await realpath(backupPath);
  if (
    path.resolve(manifest.settingsPath) !== expectedTarget ||
    !isPathInside(canonicalBackupPath, expectedBackupRoot)
  ) {
    throw new Error("before-image manifest targets an unexpected path");
  }
  const backupStat = await lstat(canonicalBackupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error("before-image backup must be a regular non-symlink file");
  }
  const bytes = await readFile(canonicalBackupPath);
  if (
    bytes.length !== manifest.byteLength ||
    sha256(bytes) !== manifest.contentSha256
  ) {
    throw new Error("before-image backup hash or size mismatch");
  }
  const target = expectedTarget;
  const targetStat = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (targetStat?.isSymbolicLink()) {
    throw new Error("rollback target cannot be a symlink");
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${random(8).toString("hex")}.restore`,
  );
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
