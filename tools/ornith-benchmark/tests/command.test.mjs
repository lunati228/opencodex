import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAllowlistedCommand } from "../src/command.mjs";
import { tempRoot } from "./temp-root.mjs";

test("command execution uses argv without shell interpretation", async () => {
  const root = await tempRoot("ornith-command-");
  const script = path.join(root, "echo-argv.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const command = {
    id: "literal-argv",
    executable: process.execPath,
    args: [script, "literal;&|$()", "two words"],
  };

  const result = await runAllowlistedCommand({
    command: { executable: command.executable, args: command.args },
    allowlist: [command],
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), ["literal;&|$()", "two words"]);
  assert.equal(result.command.shell, false);
  assert.equal(result.exit_code, 0);
});

test("command output is bounded and records truncation", async () => {
  const root = await tempRoot("ornith-command-cap-");
  const script = path.join(root, "large.mjs");
  await writeFile(script, "process.stdout.write('x'.repeat(10000));");
  const command = {
    id: "bounded",
    executable: process.execPath,
    args: [script],
  };

  const result = await runAllowlistedCommand({
    command: { executable: command.executable, args: command.args },
    allowlist: [command],
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 128,
  });
  assert.equal(Buffer.byteLength(result.stdout), 128);
  assert.equal(result.stdout_truncated, true);
});

test("network guard blocks outbound APIs in allowlisted tests", async () => {
  const root = await tempRoot("ornith-network-");
  const guard = fileURLToPath(
    new URL("../security/network-guard.cjs", import.meta.url),
  );
  const command = {
    id: "network-denied",
    executable: process.execPath,
    args: [
      "--require",
      guard,
      "-e",
      "fetch('https://example.com').catch(()=>{});",
    ],
  };
  const result = await runAllowlistedCommand({
    command,
    allowlist: [command],
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /ORNITH_NETWORK_DISABLED/);
});
