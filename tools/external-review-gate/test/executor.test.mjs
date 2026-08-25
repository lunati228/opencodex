import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnReviewedCommand } from "../src/executor.mjs";
import { executableIdentity } from "../src/canonical.mjs";

function fakeChild({ pid, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid ?? 4242;
  child.exitCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (closeOnKill && child.exitCode === null) {
      child.exitCode = 1;
      queueMicrotask(() => child.emit("close", 1));
    }
    return true;
  };
  return child;
}

test("inactive executor uses the strict allowlist and suppresses command output", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-exec-"));
  const identity = await executableIdentity(process.execPath);
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [
        "-e",
        "process.exit(process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS ? 9 : 0)",
      ],
      cwd,
      timeoutMs: 5_000,
    },
    {
      sourceEnvironment: {
        ...process.env,
        OPENAI_API_KEY: "SYNTHETIC_SECRET",
        NODE_OPTIONS: "--require synthetic-malicious.js",
      },
    },
  );
  assert.deepEqual(result, { exitCode: 0, timedOut: false });
});

test("inactive executor enforces the approved timeout", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-exec-"));
  const identity = await executableIdentity(process.execPath);
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd,
      timeoutMs: 50,
    },
    { sourceEnvironment: process.env },
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("hung Windows tree killer is bounded and direct fallback completes timeout", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-hung-kill-"));
  const identity = await executableIdentity(process.execPath);
  const mainChild = fakeChild({ pid: 5001 });
  const hungTreeKiller = fakeChild({ pid: 5002, closeOnKill: false });
  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    return spawnCalls.length === 1 ? mainChild : hungTreeKiller;
  };
  const startedAt = Date.now();
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [],
      cwd,
      timeoutMs: 10,
    },
    {
      sourceEnvironment: { SystemRoot: "C:\\Windows" },
      spawnImpl,
      platform: "win32",
      terminationGraceMs: 25,
    },
  );
  assert.deepEqual(result, { exitCode: 1, timedOut: true });
  assert.equal(spawnCalls.length, 2);
  assert.equal(
    spawnCalls[1][0],
    "C:\\Windows\\System32\\taskkill.exe",
  );
  assert.equal(hungTreeKiller.killCalls, 1);
  assert.equal(mainChild.killCalls, 1);
  assert.ok(Date.now() - startedAt < 500);
});

test("failed Windows tree killer still uses direct fallback without rejection", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-failed-kill-"));
  const identity = await executableIdentity(process.execPath);
  const mainChild = fakeChild({ pid: 6001 });
  const failedTreeKiller = fakeChild({ pid: 6002, closeOnKill: false });
  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return mainChild;
    queueMicrotask(() =>
      failedTreeKiller.emit("error", new Error("synthetic taskkill failure")),
    );
    return failedTreeKiller;
  };
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [],
      cwd,
      timeoutMs: 10,
    },
    {
      sourceEnvironment: { SystemRoot: "C:\\Windows" },
      spawnImpl,
      platform: "win32",
      terminationGraceMs: 25,
    },
  );
  assert.deepEqual(result, { exitCode: 1, timedOut: true });
  assert.equal(spawnCalls.length, 2);
  assert.equal(mainChild.killCalls, 1);
});

test("relative SystemRoot is never trusted to locate taskkill", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-systemroot-"));
  const identity = await executableIdentity(process.execPath);
  const mainChild = fakeChild({ pid: 7001 });
  const spawnCalls = [];
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [],
      cwd,
      timeoutMs: 10,
    },
    {
      sourceEnvironment: { SystemRoot: "relative\\attacker" },
      spawnImpl: (...args) => {
        spawnCalls.push(args);
        return mainChild;
      },
      platform: "win32",
      terminationGraceMs: 25,
    },
  );
  assert.deepEqual(result, { exitCode: 1, timedOut: true });
  assert.equal(spawnCalls.length, 1);
  assert.equal(mainChild.killCalls, 1);
});

test("absolute shell-free execution ignores shadowed PATH and COMSPEC binaries", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-shadow-"));
  const marker = path.join(cwd, "shadow-ran");
  await writeFile(
    path.join(cwd, "node.cmd"),
    `@echo shadow>${JSON.stringify(marker)}`,
    "utf8",
  );
  const identity = await executableIdentity(process.execPath);
  const result = await spawnReviewedCommand(
    {
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: ["-e", "process.exit(0)"],
      cwd,
      timeoutMs: 5_000,
    },
    {
      sourceEnvironment: {
        ...process.env,
        PATH: cwd,
        COMSPEC: path.join(cwd, "node.cmd"),
      },
    },
  );
  assert.equal(result.exitCode, 0);
  await assert.rejects(access(marker));
});

test("changed executable identity is rejected immediately before spawn", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-identity-"));
  const copiedExecutable = path.join(cwd, "copied-node.exe");
  await copyFile(process.execPath, copiedExecutable);
  const identity = await executableIdentity(copiedExecutable);
  await writeFile(copiedExecutable, "changed", "utf8");
  await assert.rejects(
    spawnReviewedCommand({
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [],
      cwd,
      timeoutMs: 1_000,
    }),
    /identity changed/i,
  );
});

test("same-length executable rewrite with restored mtime changes identity", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-review-content-"));
  const copiedExecutable = path.join(cwd, "copied-node.exe");
  await copyFile(process.execPath, copiedExecutable);
  const fixedTime = new Date("2020-01-01T00:00:00.000Z");
  await utimes(copiedExecutable, fixedTime, fixedTime);
  const before = await stat(copiedExecutable, { bigint: true });
  const identity = await executableIdentity(copiedExecutable);

  const handle = await open(copiedExecutable, "r+");
  try {
    const firstByte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(firstByte, 0, 1, 0);
    assert.equal(bytesRead, 1);
    firstByte[0] ^= 0xff;
    const { bytesWritten } = await handle.write(firstByte, 0, 1, 0);
    assert.equal(bytesWritten, 1);
  } finally {
    await handle.close();
  }
  await utimes(copiedExecutable, fixedTime, fixedTime);
  const after = await stat(copiedExecutable, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);

  await assert.rejects(
    spawnReviewedCommand({
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: [],
      cwd,
      timeoutMs: 1_000,
    }),
    /identity changed/i,
  );
});

test("changed cwd identity is rejected immediately before spawn", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-cwd-"));
  const cwd = path.join(base, "cwd");
  const original = path.join(base, "original");
  const outside = path.join(base, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const identity = await executableIdentity(process.execPath);
  await rename(cwd, original);
  try {
    await symlink(
      outside,
      cwd,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(
    spawnReviewedCommand({
      executable: identity.canonicalPath,
      executableIdentitySha256: identity.sha256,
      argv: ["--version"],
      cwd,
      timeoutMs: 1_000,
    }),
    /cwd identity changed/i,
  );
});
