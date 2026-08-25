import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempRoot } from "./temp-root.mjs";

import {
  assertAllowedCommand,
  buildSanitizedEnvironment,
  resolveContainedPath,
} from "../src/security.mjs";

test("contained paths reject traversal and absolute escapes", async () => {
  const root = await tempRoot("ornith-security-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "ok.txt"), "ok");

  assert.equal(
    await resolveContainedPath(root, "src/ok.txt"),
    path.join(root, "src", "ok.txt"),
  );
  await assert.rejects(resolveContainedPath(root, "../escape.txt"), /PATH_ESCAPE/);
  await assert.rejects(
    resolveContainedPath(root, path.resolve(root, "..", "escape.txt")),
    /PATH_ESCAPE/,
  );
});

test("commands are exact argv tuples and reject shells or non-allowlisted variants", () => {
  const allowlist = [
    {
      id: "focused",
      executable: process.execPath,
      args: ["--test", "tests/focused.test.mjs"],
    },
  ];

  assert.deepEqual(
    assertAllowedCommand(
      {
        executable: process.execPath,
        args: ["--test", "tests/focused.test.mjs"],
      },
      allowlist,
    ),
    allowlist[0],
  );
  assert.throws(
    () =>
      assertAllowedCommand(
        {
          executable: process.execPath,
          args: ["--test", "tests/focused.test.mjs", "&", "whoami"],
        },
        allowlist,
      ),
    /COMMAND_NOT_ALLOWLISTED/,
  );
  assert.throws(
    () =>
      assertAllowedCommand(
        { executable: "powershell.exe", args: ["-Command", "whoami"] },
        allowlist,
      ),
    /FORBIDDEN_EXECUTABLE/,
  );
});

test("child environment drops secrets and forces offline markers", () => {
  const environment = buildSanitizedEnvironment({
    PATH: "safe",
    ProgramFiles: "C:\\forged-program-files",
    SystemRoot: "C:\\Windows",
    API_TOKEN: "must-not-leak",
    npm_config_registry: "https://registry.example",
  });

  assert.equal(environment.PATH, "safe");
  assert.equal(environment.ProgramFiles, "C:\\Program Files");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.API_TOKEN, undefined);
  assert.equal(environment.npm_config_registry, undefined);
  assert.equal(environment.ORNITH_NETWORK_DISABLED, "1");
  assert.equal(environment.NO_PROXY, "*");
});
