import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBeforeImage,
  restoreBeforeImage,
} from "../src/before-image.mjs";

const manifestKey = Buffer.alloc(32, 4);

test("before-image manifest contains hashes and restores exact bytes without embedding contents", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-before-"));
  const settingsPath = path.join(base, "settings.json");
  const backupDirectory = path.join(base, "protected-backups");
  const manifestPath = path.join(base, "before-image.json");
  const original = Buffer.from(
    '{"provider":"synthetic","token":"SYNTHETIC_SECRET_NOT_FOR_MANIFEST"}',
    "utf8",
  );
  await writeFile(settingsPath, original);
  const manifest = await createBeforeImage({
    settingsPath,
    backupDirectory,
    manifestPath,
    manifestKey,
  });
  const manifestText = await readFile(manifestPath, "utf8");
  assert.equal(manifestText.includes("SYNTHETIC_SECRET_NOT_FOR_MANIFEST"), false);
  assert.equal(manifest.byteLength, original.length);
  await writeFile(settingsPath, "changed", "utf8");
  await restoreBeforeImage({
    manifestPath,
    expectedSettingsPath: settingsPath,
    expectedBackupDirectory: backupDirectory,
    manifestKey,
  });
  assert.deepEqual(await readFile(settingsPath), original);
});

test("rollback refuses a modified backup", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-before-"));
  const settingsPath = path.join(base, "settings.json");
  const backupDirectory = path.join(base, "protected-backups");
  const manifestPath = path.join(base, "before-image.json");
  await writeFile(settingsPath, "original", "utf8");
  const manifest = await createBeforeImage({
    settingsPath,
    backupDirectory,
    manifestPath,
    manifestKey,
  });
  await writeFile(manifest.backupPath, "tampered", "utf8");
  await assert.rejects(
    restoreBeforeImage({
      manifestPath,
      expectedSettingsPath: settingsPath,
      expectedBackupDirectory: backupDirectory,
      manifestKey,
    }),
    /hash/i,
  );
});

test("rollback refuses a manifest redirected to another target", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-before-"));
  const settingsPath = path.join(base, "settings.json");
  const otherPath = path.join(base, "other.json");
  const backupDirectory = path.join(base, "protected-backups");
  const manifestPath = path.join(base, "before-image.json");
  await writeFile(settingsPath, "original", "utf8");
  await writeFile(otherPath, "other", "utf8");
  const manifest = await createBeforeImage({
    settingsPath,
    backupDirectory,
    manifestPath,
    manifestKey,
  });
  const tampered = { ...manifest, settingsPath: otherPath };
  await writeFile(manifestPath, JSON.stringify(tampered), "utf8");
  await assert.rejects(
    restoreBeforeImage({
      manifestPath,
      expectedSettingsPath: settingsPath,
      expectedBackupDirectory: backupDirectory,
      manifestKey,
    }),
    /HMAC|unexpected path/i,
  );
  assert.equal(await readFile(otherPath, "utf8"), "other");
});

test("rollback refuses a junction escape inside the expected backup directory", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-before-"));
  const settingsPath = path.join(base, "settings.json");
  const backupDirectory = path.join(base, "protected-backups");
  const outsideDirectory = path.join(base, "outside");
  const aliasDirectory = path.join(backupDirectory, "alias");
  const manifestPath = path.join(base, "before-image.json");
  await writeFile(settingsPath, "original", "utf8");
  await mkdir(backupDirectory);
  await mkdir(outsideDirectory);
  try {
    await symlink(
      outsideDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.code}`);
    return;
  }
  const outsideBackup = path.join(outsideDirectory, "replacement.bin");
  await writeFile(outsideBackup, "attacker-controlled", "utf8");
  const legitimateManifest = await createBeforeImage({
    settingsPath,
    backupDirectory,
    manifestPath,
    manifestKey,
  });
  const escapedPath = path.join(aliasDirectory, "replacement.bin");
  const escapedBytes = await readFile(escapedPath);
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...legitimateManifest,
      backupPath: escapedPath,
      byteLength: escapedBytes.length,
      contentSha256:
        "06c9fd4b24743b4e2e8466097a544e3b46e05c9a1154134736bf74f12c65eb44",
    }),
    "utf8",
  );
  await assert.rejects(
    restoreBeforeImage({
      manifestPath,
      expectedSettingsPath: settingsPath,
      expectedBackupDirectory: backupDirectory,
      manifestKey,
    }),
    /HMAC|unexpected path/i,
  );
});

test("paired backup and manifest tampering fails HMAC verification", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-before-"));
  const settingsPath = path.join(base, "settings.json");
  const backupDirectory = path.join(base, "protected-backups");
  const manifestPath = path.join(base, "before-image.json");
  await writeFile(settingsPath, "original", "utf8");
  const manifest = await createBeforeImage({
    settingsPath,
    backupDirectory,
    manifestPath,
    manifestKey,
  });
  const tamperedBytes = Buffer.from("paired-tamper", "utf8");
  await writeFile(manifest.backupPath, tamperedBytes);
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      byteLength: tamperedBytes.length,
      contentSha256:
        "c419442669f82c151e9799f15e074f5b1c5f5b834f29f4ca671d26d002c45445",
    }),
    "utf8",
  );
  await assert.rejects(
    restoreBeforeImage({
      manifestPath,
      expectedSettingsPath: settingsPath,
      expectedBackupDirectory: backupDirectory,
      manifestKey,
    }),
    /HMAC/i,
  );
});
