import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Bytes } from "./hash.mjs";
import { assertSafeCaseId, resolveContainedPath } from "./security.mjs";

function safeRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
    throw new Error(`INVALID_RUN_ID: ${runId}`);
  }
  return runId;
}

async function writeNewFile(caseRoot, relativePath, content) {
  const destination = await resolveContainedPath(caseRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
}

export async function materializeCase({
  sandboxRoot,
  runId,
  fixtureCase,
}) {
  safeRunId(runId);
  assertSafeCaseId(fixtureCase.id);
  await mkdir(sandboxRoot, { recursive: true });
  const runRoot = await resolveContainedPath(sandboxRoot, runId);
  await mkdir(runRoot, { recursive: true });
  const caseRoot = await resolveContainedPath(runRoot, fixtureCase.id);
  try {
    await mkdir(caseRoot, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`CASE_WORKSPACE_EXISTS: ${caseRoot}`);
    }
    throw error;
  }

  const baseline = [];
  for (const file of fixtureCase.files) {
    if (!file.hash_valid) {
      throw new Error(`FIXTURE_HASH_MISMATCH: ${fixtureCase.id}:${file.path}`);
    }
    await writeNewFile(caseRoot, file.path, file.content);
    baseline.push({
      path: file.path,
      role: file.role,
      sha256: file.sha256,
      content: file.content,
    });
  }

  // A minimal, local-only Git repository marker. No Git process, index, stage,
  // commit, hook, config inheritance, or remote is used by the harness.
  await mkdir(path.join(caseRoot, ".git", "objects"), { recursive: true });
  await mkdir(path.join(caseRoot, ".git", "refs", "heads"), { recursive: true });
  await writeFile(path.join(caseRoot, ".git", "HEAD"), "ref: refs/heads/fixture\n");
  await writeFile(
    path.join(caseRoot, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
  );
  await mkdir(path.join(caseRoot, ".ornith-control"), { recursive: true });
  await writeFile(
    path.join(caseRoot, ".ornith-control", "baseline.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
    { flag: "wx" },
  );

  return {
    caseRoot,
    fixtureCase,
    starting_tree_sha256: sha256Bytes(
      canonicalJson(
        baseline.map(({ path: filePath, role, sha256 }) => ({
          path: filePath,
          role,
          sha256,
        })),
      ),
    ),
  };
}
