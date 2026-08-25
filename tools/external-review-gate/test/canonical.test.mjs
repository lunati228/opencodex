import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRequestBytes } from "../src/canonical.mjs";

async function requestFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-canonical-"));
  const projectRoot = path.join(base, "project");
  await mkdir(projectRoot);
  const request = {
    version: 1,
    executable: process.execPath,
    argv: ["--version"],
    cwd: projectRoot,
    timeoutMs: 1_000,
    authLevel: "medium",
    requestNonce: "1".repeat(32),
  };
  return { base, projectRoot, request };
}

test("request accepts only the exact deterministic JSON.stringify byte encoding", async () => {
  const { projectRoot, request } = await requestFixture();
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  const parsed = await parseRequestBytes(bytes, { projectRoot });
  assert.equal(parsed.executable, request.executable);
});

test("request rejects duplicate executable keys", async () => {
  const { projectRoot, request } = await requestFixture();
  const duplicate = Buffer.from(
    `{"version":1,"executable":"first","executable":${JSON.stringify(request.executable)},"argv":["--version"],"cwd":${JSON.stringify(request.cwd)},"timeoutMs":1000,"authLevel":"medium","requestNonce":"${request.requestNonce}"}`,
    "utf8",
  );
  await assert.rejects(
    parseRequestBytes(duplicate, { projectRoot }),
    /canonical/i,
  );
});

test("request rejects whitespace and escape-equivalent encodings", async (t) => {
  const { projectRoot, request } = await requestFixture();
  await t.test("whitespace", async () => {
    const pretty = Buffer.from(JSON.stringify(request, null, 2), "utf8");
    await assert.rejects(
      parseRequestBytes(pretty, { projectRoot }),
      /canonical/i,
    );
  });
  await t.test("escape-equivalent executable", async () => {
    const escaped = Buffer.from(
      JSON.stringify(request).replace(
        request.executable[0],
        `\\u${request.executable.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
      "utf8",
    );
    await assert.rejects(
      parseRequestBytes(escaped, { projectRoot }),
      /canonical/i,
    );
  });
  await t.test("property order", async () => {
    const reordered = Buffer.from(
      JSON.stringify({
        executable: request.executable,
        version: 1,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        authLevel: request.authLevel,
        requestNonce: request.requestNonce,
      }),
      "utf8",
    );
    await assert.rejects(
      parseRequestBytes(reordered, { projectRoot }),
      /canonical/i,
    );
  });
});

test("request nonce uses exactly 128 bits of lowercase hex", async () => {
  const { projectRoot, request } = await requestFixture();
  for (const requestNonce of [
    "A".repeat(32),
    "1".repeat(31),
    "1".repeat(33),
    "g".repeat(32),
  ]) {
    await assert.rejects(
      parseRequestBytes(
        Buffer.from(JSON.stringify({ ...request, requestNonce }), "utf8"),
        { projectRoot },
      ),
      /request nonce/i,
    );
  }
});

test("request rejects an executable path alias that hides the resolved target", async (t) => {
  const { base, projectRoot, request } = await requestFixture();
  const aliasDirectory = path.join(base, "aliased-bin");
  try {
    await symlink(
      path.dirname(process.execPath),
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.code}`);
    return;
  }
  const bytes = Buffer.from(
    JSON.stringify({
      ...request,
      executable: path.join(aliasDirectory, path.basename(process.execPath)),
    }),
    "utf8",
  );
  await assert.rejects(
    parseRequestBytes(bytes, { projectRoot }),
    /canonical executable path/i,
  );
});

test("request rejects a cwd alias even when it resolves inside the project", async (t) => {
  const { projectRoot, request } = await requestFixture();
  const realCwd = path.join(projectRoot, "real-cwd");
  const aliasCwd = path.join(projectRoot, "alias-cwd");
  await mkdir(realCwd);
  try {
    await symlink(
      realCwd,
      aliasCwd,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.code}`);
    return;
  }
  const bytes = Buffer.from(
    JSON.stringify({ ...request, cwd: aliasCwd }),
    "utf8",
  );
  await assert.rejects(
    parseRequestBytes(bytes, { projectRoot }),
    /canonical cwd path/i,
  );
});

test(
  "Windows canonical path comparison accepts case-only spelling differences",
  { skip: process.platform !== "win32" },
  async () => {
    const { projectRoot, request } = await requestFixture();
    const executableWithChangedDriveCase =
      request.executable[0] === request.executable[0].toLowerCase()
        ? request.executable[0].toUpperCase() + request.executable.slice(1)
        : request.executable[0].toLowerCase() + request.executable.slice(1);
    const bytes = Buffer.from(
      JSON.stringify({
        ...request,
        executable: executableWithChangedDriveCase,
      }),
      "utf8",
    );
    const parsed = await parseRequestBytes(bytes, { projectRoot });
    assert.equal(parsed.executable, await realpath(request.executable));
  },
);
