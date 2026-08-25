import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeCase } from "../src/fixture.mjs";
import { loadQualitySuite } from "../src/quality-suite.mjs";
import { executeTool } from "../src/tools.mjs";
import { tempRoot } from "./temp-root.mjs";

const suitePath = new URL(
  "../fixtures/ornith-quality-v1/manifest.json",
  import.meta.url,
);

async function createCase(caseId) {
  const sandbox = await tempRoot("ornith-tools-");
  const suite = await loadQualitySuite(suitePath);
  const fixtureCase = suite.cases.find(({ id }) => id === caseId);
  const materialized = await materializeCase({
    sandboxRoot: sandbox,
    runId: "run-001",
    fixtureCase,
  });
  return { fixtureCase, ...materialized };
}

async function sandboxedTestContext(source, { executable = "@node" } = {}) {
  const caseRoot = await tempRoot("ornith-run-tests-");
  await Promise.all([
    mkdir(path.join(caseRoot, "tests"), { recursive: true }),
    mkdir(path.join(caseRoot, ".ornith-hidden"), { recursive: true }),
    mkdir(path.join(caseRoot, ".ornith-control"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(caseRoot, "tests", "focused.test.mjs"), source),
    writeFile(
      path.join(caseRoot, ".ornith-hidden", "oracle.test.mjs"),
      "import test from 'node:test';\ntest('oracle', () => {});\n",
    ),
    writeFile(
      path.join(caseRoot, ".ornith-control", "baseline.json"),
      "protected-control",
    ),
  ]);
  return {
    caseRoot,
    fixtureCase: {
      allowed_paths: [],
      allowed_commands: [
        {
          id: "focused",
          executable,
          args: [
            "--require",
            "@network_guard",
            "--test",
            "tests/focused.test.mjs",
            ".ornith-hidden/oracle.test.mjs",
          ],
        },
      ],
    },
  };
}

async function runSandboxedSource(source, options) {
  const context = await sandboxedTestContext(source, options);
  const result = await executeTool(context, "run_tests", {
    command_id: "focused",
  });
  return { context, result };
}

test("file tools hide control/oracle data and reject path escapes", async () => {
  const context = await createCase("E-01");
  const listed = await executeTool(context, "list_files", {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.files, ["src/profile.ts"]);

  const read = await executeTool(context, "read_file", {
    path: "src/profile.ts",
  });
  assert.match(read.content, /profileName/);
  const hidden = await executeTool(context, "read_file", {
    path: ".ornith-hidden/oracle.test.mjs",
  });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.error_code, "PROTECTED_PATH");
  for (const hiddenAlias of [
    "./.ornith-hidden/oracle.test.mjs",
    "src/../.ornith-hidden/oracle.test.mjs",
    ".ORNITH-HIDDEN/oracle.test.mjs",
    path.join(context.caseRoot, ".ornith-hidden", "oracle.test.mjs"),
  ]) {
    const aliased = await executeTool(context, "read_file", {
      path: hiddenAlias,
    });
    assert.equal(aliased.ok, false, hiddenAlias);
    assert.equal(aliased.error_code, "PROTECTED_PATH", hiddenAlias);
  }
  const escaped = await executeTool(context, "read_file", {
    path: "../outside.txt",
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error_code, "PATH_ESCAPE");
});

test("apply_patch requires the expected starting hash and allowed path", async () => {
  const context = await createCase("E-01");
  const stale = await executeTool(context, "apply_patch", {
    path: "src/profile.ts",
    expected_sha256: "0".repeat(64),
    replacements: [{ old: "return", new: "return" }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error_code, "STALE_FILE_HASH");
  const originalHash = context.fixtureCase.files[0].sha256;
  const patched = await executeTool(context, "apply_patch", {
    path: "src/profile.ts",
    expected_sha256: originalHash,
    replacements: [
      {
        old: "return String(value).trim();",
        new: "const result = String(value).trim();\n  if (!result) throw new Error('profile name is required');\n  return result;",
      },
    ],
  });
  assert.equal(patched.ok, true);
  assert.notEqual(patched.sha256, originalHash);

  const created = await executeTool(context, "apply_patch", {
    path: "tests/focused.test.mjs",
    expected_sha256: null,
    create_content: "import test from 'node:test';\ntest('focused', () => {});\n",
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);

  const diff = await executeTool(context, "get_diff", {});
  assert.deepEqual(diff.changed_paths, [
    "src/profile.ts",
    "tests/focused.test.mjs",
  ]);
});

test("stop/ask cases expose no mutating command or path", async () => {
  const context = await createCase("S-02");
  const patch = await executeTool(context, "apply_patch", {
    path: "src/cache.mjs",
    expected_sha256: context.fixtureCase.files[0].sha256,
    replacements: [{ old: "cache", new: "deleted" }],
  });
  assert.equal(patch.ok, false);
  assert.equal(patch.error_code, "PATH_NOT_ALLOWLISTED");
  const tests = await executeTool(context, "run_tests", {
    command_id: "focused",
  });
  assert.equal(tests.ok, false);
  assert.equal(tests.error_code, "COMMAND_NOT_ALLOWLISTED");
});

test("tool arguments reject undeclared properties", async () => {
  const context = await createCase("E-01");
  const result = await executeTool(context, "list_files", {
    injected: "ignored would be unsafe",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_TOOL_ARGUMENTS");
});

test("run_tests permission sandbox denies child processes and outside reads", async () => {
  const outside = path.join(
    await tempRoot("ornith-outside-"),
    "secret.txt",
  );
  await writeFile(outside, "outside-secret");
  for (const source of [
    "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['-e', '0']);\n",
    `import { readFileSync } from 'node:fs';\nreadFileSync(${JSON.stringify(outside)}, 'utf8');\n`,
  ]) {
    const { result } = await runSandboxedSource(source);
    assert.equal(result.ok, false);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /ERR_ACCESS_DENIED|ORNITH_NETWORK_DISABLED|permission/i,
    );
  }
});

test("run_tests permission sandbox still executes the declared focused tests", async () => {
  const { result } = await runSandboxedSource(
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('focused', () => assert.equal(2 + 2, 4));\n",
  );
  assert.equal(
    result.ok,
    true,
    JSON.stringify({
      commands: result.commands,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  assert.equal(result.commands.length, 2);
  for (const command of result.commands) {
    assert.equal(command.shell, false);
    assert.equal(command.executable, process.execPath);
    assert.ok(command.args.includes("--permission"));
    assert.ok(command.args.includes("--input-type=module"));
    assert.ok(command.args.includes("-"));
  }
  assert.equal(
    result.commands[0].args.includes(".ornith-hidden/oracle.test.mjs"),
    false,
  );
  assert.equal(
    result.commands[1].args.includes("tests/focused.test.mjs"),
    false,
  );
});

test("run_tests focused process cannot read or print the hidden oracle", async () => {
  const marker = "ORNITH_ORACLE_SOURCE_MUST_NOT_LEAK";
  const context = await sandboxedTestContext(
    `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('../.ornith-hidden/oracle.test.mjs', 'utf8'));\n`,
  );
  await writeFile(
    path.join(context.caseRoot, ".ornith-hidden", "oracle.test.mjs"),
    `import test from 'node:test';\ntest('oracle', () => {});\n// ${marker}\n`,
  );
  const result = await executeTool(context, "run_tests", {
    command_id: "focused",
  });
  assert.equal(result.ok, false);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /ERR_ACCESS_DENIED|permission/i,
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
});

test("run_tests blocks fetch, sockets, and public native binding bypasses", async () => {
  for (const source of [
    "await fetch('https://example.com');\n",
    "import net from 'node:net';\nnet.connect(443, 'example.com');\n",
    "const { ClientRequest } = process.getBuiltinModule('_http_client');\nnew ClientRequest('http://example.com');\n",
    "import dns from 'node:dns';\nnew dns.Resolver().resolve4('example.com', () => {});\n",
    "process.binding('tcp_wrap');\n",
  ]) {
    const { result } = await runSandboxedSource(source);
    assert.equal(result.ok, false);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /ORNITH_NETWORK_DISABLED|ERR_ACCESS_DENIED/,
    );
  }
});

test("run_tests clears NODE_OPTIONS instead of accepting permission bypasses", async () => {
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--allow-child-process";
  try {
    const { result } = await runSandboxedSource(
      "if (process.env.NODE_OPTIONS !== '') throw new Error(`NODE_OPTIONS_LEAKED:${process.env.NODE_OPTIONS}`);\nimport { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['-e', '0']);\n",
    );
    assert.equal(result.ok, false);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /child_process\.spawnSync/,
    );
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /NODE_OPTIONS_LEAKED/,
    );
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
  }
});

test("run_tests cannot mutate model tests, hidden oracle, or control state", async () => {
  const { context, result } = await runSandboxedSource(
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('.ornith-hidden/oracle.test.mjs', 'pwned');\n",
  );
  assert.equal(result.ok, false);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /ERR_ACCESS_DENIED|permission/i,
  );
  assert.match(
    await readFile(
      path.join(context.caseRoot, ".ornith-hidden", "oracle.test.mjs"),
      "utf8",
    ),
    /test\('oracle'/,
  );
  assert.equal(
    await readFile(
      path.join(context.caseRoot, ".ornith-control", "baseline.json"),
      "utf8",
    ),
    "protected-control",
  );
});

test("run_tests cannot report success by terminating its own sandbox", async () => {
  const { result } = await runSandboxedSource("process.exit(0);\n");
  assert.equal(result.ok, false);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /ORNITH_NETWORK_DISABLED: process\.exit/,
  );
});

test("run_tests rejects alternate executables before spawning", async () => {
  const { result } = await runSandboxedSource(
    "throw new Error('must not execute');\n",
    { executable: process.execPath },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "RUN_TESTS_EXECUTABLE_FORBIDDEN");
});
