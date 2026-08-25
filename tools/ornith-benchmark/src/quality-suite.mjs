import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Bytes } from "./hash.mjs";

export async function loadQualitySuite(manifestPath) {
  const resolvedManifestPath =
    manifestPath instanceof URL ? fileURLToPath(manifestPath) : manifestPath;
  const parsed = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const payload = structuredClone(parsed);
  delete payload.suite_sha256;
  const computedSuiteHash = sha256Bytes(canonicalJson(payload));

  const cases = parsed.cases.map((fixtureCase) => ({
    ...fixtureCase,
    files: fixtureCase.files.map((file) => ({
      ...file,
      hash_valid: sha256Bytes(Buffer.from(file.content, "utf8")) === file.sha256,
    })),
  }));
  const toolSchemaPath = path.resolve(
    path.dirname(resolvedManifestPath),
    parsed.tool_schema_file.path,
  );
  const toolSchemaBytes = await readFile(toolSchemaPath);
  const toolSchemas = JSON.parse(toolSchemaBytes.toString("utf8"));
  const toolSchemaHashValid =
    sha256Bytes(toolSchemaBytes) === parsed.tool_schema_file.sha256;
  return {
    ...parsed,
    cases,
    computed_suite_sha256: computedSuiteHash,
    hash_valid: computedSuiteHash === parsed.suite_sha256,
    tool_schemas: toolSchemas,
    tool_schema_hash_valid: toolSchemaHashValid,
  };
}
