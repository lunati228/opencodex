import assert from "node:assert/strict";
import test from "node:test";

import { loadQualitySuite } from "../src/quality-suite.mjs";

const suitePath = new URL(
  "../fixtures/ornith-quality-v1/manifest.json",
  import.meta.url,
);

test("ornith-quality-v1 contains the exact 17 protocol cases", async () => {
  const suite = await loadQualitySuite(suitePath);
  assert.equal(suite.id, "ornith-quality-v1");
  assert.deepEqual(
    suite.cases.map(({ id }) => id),
    [
      "E-01",
      "E-02",
      "E-03",
      "E-04",
      "E-05",
      "D-01",
      "D-02",
      "D-03",
      "T-01",
      "T-02",
      "T-03",
      "A-01",
      "A-02",
      "S-01",
      "S-02",
      "R-01",
      "R-02",
    ],
  );
  assert.deepEqual(suite.category_counts, {
    edit: 5,
    debug: 3,
    tool_chain: 3,
    ambiguous: 2,
    stop_ask: 2,
    second_attempt: 2,
  });
  assert.match(suite.suite_sha256, /^[a-f0-9]{64}$/);
  assert.equal(suite.hash_valid, true);
  assert.equal(suite.tool_schema_hash_valid, true);
  assert.deepEqual(
    suite.tool_schemas.map(({ function: definition }) => definition.name),
    suite.tool_names,
  );
});

test("every fixture file has an immutable content hash", async () => {
  const suite = await loadQualitySuite(suitePath);
  for (const fixtureCase of suite.cases) {
    assert.ok(fixtureCase.prompt.length > 0, fixtureCase.id);
    assert.ok(fixtureCase.oracle.length > 0, fixtureCase.id);
    assert.ok(fixtureCase.files.length >= 2, fixtureCase.id);
    assert.ok(
      fixtureCase.files.some(({ role }) => role === "hidden"),
      `${fixtureCase.id}: hidden oracle`,
    );
    for (const file of fixtureCase.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/, `${fixtureCase.id}:${file.path}`);
      assert.equal(file.hash_valid, true, `${fixtureCase.id}:${file.path}`);
    }
  }
});
