import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeCase } from "../src/fixture.mjs";
import { loadQualitySuite } from "../src/quality-suite.mjs";
import { tempRoot } from "./temp-root.mjs";

const suitePath = new URL(
  "../fixtures/ornith-quality-v1/manifest.json",
  import.meta.url,
);

test("each case is materialized once into its own disposable workspace", async () => {
  const sandbox = await tempRoot("ornith-fixture-");
  const suite = await loadQualitySuite(suitePath);
  const fixtureCase = suite.cases.find(({ id }) => id === "E-01");
  const result = await materializeCase({
    sandboxRoot: sandbox,
    runId: "run-001",
    fixtureCase,
  });

  assert.equal(
    await readFile(path.join(result.caseRoot, "src", "profile.ts"), "utf8"),
    fixtureCase.files[0].content,
  );
  assert.equal(
    (await stat(path.join(result.caseRoot, ".git"))).isDirectory(),
    true,
  );
  assert.match(result.starting_tree_sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    materializeCase({
      sandboxRoot: sandbox,
      runId: "run-001",
      fixtureCase,
    }),
    /CASE_WORKSPACE_EXISTS/,
  );
});
