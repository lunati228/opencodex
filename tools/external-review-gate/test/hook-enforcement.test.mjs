import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTemporaryReviewerWorkspace,
  shellQuoteArgument,
} from "../src/temporary-hook.mjs";

function runGeneratedHook({ command, cwd, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`generated hook exited ${code}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("generated temporary reviewer hook executes and denies every tool call", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-hook-"));
  const workspace = await createTemporaryReviewerWorkspace({
    baseDirectory: base,
    nodeExecutable: process.execPath,
  });
  const hooksPath = path.join(workspace, ".agents", "hooks.json");
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.equal(config["external-reviewer-no-tools"].PreToolUse[0].matcher, "*");
  const command =
    config["external-reviewer-no-tools"].PreToolUse[0].hooks[0].command;
  const result = await runGeneratedHook({
    command,
    cwd: workspace,
    payload: { toolCall: { name: "run_command", args: { command: "echo no" } } },
  });
  assert.deepEqual(result, {
    decision: "deny",
    reason: "Reviewer sessions have no execution tools.",
  });
});

test("POSIX quoting treats dollars, backticks, backslashes, and single quotes as literal data", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-quote-"));
  const marker = path.join(base, "substitution-ran");
  const argument = `literal $(touch ${marker}) \`touch ${marker}\` \\\\ ' end`;
  const quoted = shellQuoteArgument(argument, { platform: "linux" });
  assert.equal(
    quoted,
    `'literal $(touch ${marker}) \`touch ${marker}\` \\\\ '"'"' end'`,
  );
  if (process.platform !== "win32") {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(`/bin/sh -c "printf '%s' ${quoted}"`, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(stdout).toString("utf8"))
          : reject(new Error(`shell exited ${code}`)),
      );
    });
    assert.equal(result, argument);
    await assert.rejects(access(marker));
  }
});

test("Windows hook quoting rejects cmd expansion and metacharacters", () => {
  for (const value of [
    "C:\\safe\\%PATH%\\node.exe",
    "C:\\safe\\!value!\\node.exe",
    "C:\\safe\\node.exe & whoami",
    "C:\\safe\\node.exe | more",
    "C:\\safe\\node.exe^",
    'C:\\safe\\"quoted"\\node.exe',
  ]) {
    assert.throws(
      () => shellQuoteArgument(value, { platform: "win32" }),
      /invalid/i,
    );
  }
});
