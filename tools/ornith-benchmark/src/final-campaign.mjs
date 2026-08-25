import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  candidateAppendStreamPaths,
  ensureCandidateAppendStreams,
} from "./artifacts.mjs";
import { canonicalJson, sha256Bytes, sha256File } from "./hash.mjs";
import { resolveContainedPath } from "./security.mjs";

const UNITS = Object.freeze([
  ["final-bench", ["final"]],
  ["cold-1", ["server", "cold", "run-1"]],
  ["cold-2", ["server", "cold", "run-2"]],
  ["cold-3", ["server", "cold", "run-3"]],
  ["warm-quality", ["server", "warm"]],
  ["sustained", ["server", "sustained"]],
]);

const TELEMETRY_FILES = Object.freeze([
  "nvidia-query.stdout.csv",
  "nvidia-query.stderr.txt",
  "nvidia-dmon.stdout.txt",
  "nvidia-dmon.stderr.txt",
  "host-monitor.stdout.csv",
  "host-monitor.stderr.txt",
].map((name) => `telemetry/${name}`));

export const FINAL_UNIT_POLICIES = Object.freeze({
  "final-bench": Object.freeze({
    required: Object.freeze([
      ...["pp8k", "tg1024-d8k", "pp16k", "tg1024-d16k"].flatMap((id) => [
        `${id}.raw.json`,
        `${id}.stderr.txt`,
        `${id}.command.json`,
      ]),
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    dynamic: Object.freeze([]),
  }),
  "cold-1": Object.freeze({
    required: Object.freeze([
      "cold-1-warmup.sse",
      "server.stdout.txt",
      "server.stderr.txt",
      "server.command.json",
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    dynamic: Object.freeze([]),
  }),
  "cold-2": Object.freeze({
    required: Object.freeze([
      "cold-2-warmup.sse",
      "server.stdout.txt",
      "server.stderr.txt",
      "server.command.json",
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    dynamic: Object.freeze([]),
  }),
  "cold-3": Object.freeze({
    required: Object.freeze([
      "cold-3-warmup.sse",
      "server.stdout.txt",
      "server.stderr.txt",
      "server.command.json",
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    dynamic: Object.freeze([]),
  }),
  "warm-quality": Object.freeze({
    required: Object.freeze([
      "warm-quality-warmup.sse",
      "server.stdout.txt",
      "server.stderr.txt",
      "server.command.json",
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    dynamic: Object.freeze([
      Object.freeze({ suffix: ".sse", minimum: 17 }),
    ]),
  }),
  sustained: Object.freeze({
    required: Object.freeze([
      "sustained-warmup.sse",
      "server.stdout.txt",
      "server.stderr.txt",
      "server.command.json",
      ...TELEMETRY_FILES,
      "summary.json",
    ]),
    candidate_required: Object.freeze(["result.json"]),
    dynamic: Object.freeze([
      Object.freeze({ suffix: ".sse", minimum: 10 }),
    ]),
  }),
});

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, filePath);
}

async function emptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return (await readdir(directory)).length === 0;
}

function stateIdentity({
  config,
  identity,
  harnessSourceSha256,
  armComparisonManifestSha256,
  unitPolicies,
}) {
  if (
    !/^[a-f0-9]{64}$/.test(harnessSourceSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(armComparisonManifestSha256 ?? "")
  ) {
    throw new Error("FINAL_CAMPAIGN_EVIDENCE_DIGEST_INVALID");
  }
  return sha256Bytes(canonicalJson({
    config,
    identity,
    harness_source_sha256: harnessSourceSha256,
    arm_comparison_manifest_sha256: armComparisonManifestSha256,
    unit_artifact_policies: unitPolicies,
  }));
}

async function regularFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, ...relative.split("/"));
    if (entry.isDirectory()) {
      output.push(...await regularFiles(absolute, relative));
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      output.push(relative);
    } else {
      throw new Error("FINAL_CAMPAIGN_ARTIFACT_NOT_REGULAR");
    }
  }
  return output.sort();
}

function validatePolicyShape(unitId, policy) {
  if (
    !policy ||
    !Array.isArray(policy.required) ||
    !Array.isArray(policy.dynamic) ||
    (policy.required.length === 0 &&
      (policy.candidate_required?.length ?? 0) === 0 &&
      policy.dynamic.length === 0)
  ) {
    throw new Error(`FINAL_CAMPAIGN_ARTIFACT_POLICY_INVALID: ${unitId}`);
  }
  const paths = [
    ...policy.required,
    ...(policy.candidate_required ?? []),
  ];
  if (
    paths.some((value) =>
      typeof value !== "string" ||
      value.length === 0 ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/).includes("..")
    ) ||
    new Set(paths).size !== paths.length ||
    policy.dynamic.some(({ suffix, minimum }) =>
      typeof suffix !== "string" ||
      suffix.length === 0 ||
      !Number.isSafeInteger(minimum) ||
      minimum < 1
    )
  ) {
    throw new Error(`FINAL_CAMPAIGN_ARTIFACT_POLICY_INVALID: ${unitId}`);
  }
}

async function verifyUnitArtifactClosure({
  unitId,
  artifactDirectory,
  candidateRoot,
  artifactPaths,
  policy,
}) {
  validatePolicyShape(unitId, policy);
  const directoryFiles = await regularFiles(artifactDirectory);
  for (const required of policy.required) {
    if (!directoryFiles.includes(required)) {
      throw new Error(`FINAL_CAMPAIGN_REQUIRED_ARTIFACT_MISSING: ${unitId}:${required}`);
    }
  }
  for (const rule of policy.dynamic) {
    const matches = directoryFiles.filter(
      (relative) =>
        relative.endsWith(rule.suffix) &&
        !policy.required.includes(relative),
    );
    if (matches.length < rule.minimum) {
      throw new Error(`FINAL_CAMPAIGN_DYNAMIC_ARTIFACTS_MISSING: ${unitId}`);
    }
  }
  const expected = new Set(
    directoryFiles.map((relative) =>
      path.resolve(artifactDirectory, ...relative.split("/"))),
  );
  for (const relative of policy.candidate_required ?? []) {
    expected.add(path.resolve(candidateRoot, ...relative.split("/")));
  }
  const actual = new Set(artifactPaths.map((value) => path.resolve(value)));
  if (
    expected.size !== actual.size ||
    [...expected].some((value) => !actual.has(value))
  ) {
    throw new Error(`FINAL_CAMPAIGN_ARTIFACT_CLOSURE_MISMATCH: ${unitId}`);
  }
}

async function verifyArtifact(candidateRoot, artifact) {
  if (
    typeof artifact?.path !== "string" ||
    !path.isAbsolute(artifact.path) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
  ) {
    throw new Error("FINAL_STATE_ARTIFACT_INVALID");
  }
  const contained = await resolveContainedPath(candidateRoot, artifact.path);
  const metadata = await lstat(contained);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 64 * 1024 * 1024
  ) {
    throw new Error("FINAL_STATE_ARTIFACT_NOT_REGULAR");
  }
  if ((await sha256File(contained)) !== artifact.sha256) {
    throw new Error(`FINAL_STATE_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
  }
}

async function loadOrCreateState(statePath, expectedIdentity) {
  try {
    const metadata = await lstat(statePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 4 * 1024 * 1024
    ) {
      throw new Error("FINAL_CAMPAIGN_STATE_INVALID");
    }
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (
      state.schema_version !== "ornith-final-campaign-state-2" ||
      state.identity_sha256 !== expectedIdentity ||
      typeof state.units !== "object" ||
      Array.isArray(state.units)
    ) {
      throw new Error("FINAL_CAMPAIGN_RESUME_IDENTITY_MISMATCH");
    }
    return { state, created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = {
      schema_version: "ornith-final-campaign-state-2",
      identity_sha256: expectedIdentity,
      units: {},
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
    });
    return { state, created: true };
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function snapshotAppendStreams(candidateRoot) {
  const paths = await ensureCandidateAppendStreams(candidateRoot);
  return Promise.all(
    paths.map(async (filePath) => ({
      path: filePath,
      sha256: await sha256File(filePath),
    })),
  );
}

async function verifyLatestAppendStreamSnapshot(candidateRoot, state) {
  const completedIds = [];
  let gapSeen = false;
  for (const [unitId] of UNITS) {
    if (state.units[unitId]) {
      if (gapSeen) throw new Error("FINAL_CAMPAIGN_STATE_UNIT_ORDER_INVALID");
      completedIds.push(unitId);
    } else {
      gapSeen = true;
    }
  }
  if (completedIds.length === 0) return;
  const latest = state.units[completedIds.at(-1)];
  const recorded = latest.append_stream_artifacts;
  const expected = candidateAppendStreamPaths(candidateRoot).map(
    ({ path: filePath }) => normalizedPath(filePath),
  );
  if (
    !Array.isArray(recorded) ||
    recorded.length !== expected.length ||
    new Set(recorded.map(({ path: filePath }) =>
      typeof filePath === "string" ? normalizedPath(filePath) : "")).size !==
      expected.length ||
    expected.some((filePath) =>
      !recorded.some(({ path: recordedPath }) =>
        typeof recordedPath === "string" &&
        normalizedPath(recordedPath) === filePath))
  ) {
    throw new Error("FINAL_CAMPAIGN_APPEND_STREAM_EVIDENCE_INVALID");
  }
  for (const artifact of recorded) {
    await verifyArtifact(candidateRoot, artifact);
  }
}

export async function runFinalCampaign({
  config,
  identity,
  harnessSourceSha256,
  armComparisonManifestSha256,
  unitPolicies = FINAL_UNIT_POLICIES,
  cwd,
  runtime,
}) {
  if (!["on", "off"].includes(config.live?.moe_cache_mode)) {
    throw new Error("FINAL_CAMPAIGN_REQUIRES_EXPLICIT_MOE_CACHE_MODE");
  }
  if (
    typeof runtime?.runUnit !== "function" ||
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd)
  ) {
    throw new Error("FINAL_CAMPAIGN_RUNTIME_INVALID");
  }
  const candidateRoot = path.join(
    config.result_root,
    "candidates",
    config.candidate_id,
  );
  await mkdir(candidateRoot, { recursive: true });
  const statePath = path.join(candidateRoot, "final-campaign-state.json");
  for (const [unitId] of UNITS) validatePolicyShape(unitId, unitPolicies[unitId]);
  const loadedState = await loadOrCreateState(
    statePath,
    stateIdentity({
      config,
      identity,
      harnessSourceSha256,
      armComparisonManifestSha256,
      unitPolicies,
    }),
  );
  let state = loadedState.state;
  await ensureCandidateAppendStreams(candidateRoot, {
    allowCreate: loadedState.created && Object.keys(state.units).length === 0,
  });
  await verifyLatestAppendStreamSnapshot(candidateRoot, state);
  const completed = [];
  const resumed = [];

  for (const [unitId, segments] of UNITS) {
    const prior = state.units[unitId];
    if (prior) {
      if (prior.status !== "complete" || !Array.isArray(prior.artifacts)) {
        throw new Error(`FINAL_CAMPAIGN_PARTIAL_UNIT: ${unitId}`);
      }
      for (const artifact of prior.artifacts) {
        await verifyArtifact(candidateRoot, artifact);
      }
      await verifyUnitArtifactClosure({
        unitId,
        artifactDirectory: path.join(candidateRoot, ...segments),
        candidateRoot,
        artifactPaths: prior.artifacts.map(({ path: artifactPath }) => artifactPath),
        policy: unitPolicies[unitId],
      });
      resumed.push(unitId);
      continue;
    }
    const artifactDirectory = path.join(candidateRoot, ...segments);
    if (!(await emptyDirectory(artifactDirectory))) {
      throw new Error(`FINAL_CAMPAIGN_PARTIAL_UNIT: ${unitId}`);
    }
    const value = await runtime.runUnit({
      unitId,
      artifactDirectory,
      candidateRoot,
      config,
      cwd,
    });
    if (!Array.isArray(value?.artifacts) || value.artifacts.length < 1) {
      throw new Error(`FINAL_CAMPAIGN_UNIT_ARTIFACTS_MISSING: ${unitId}`);
    }
    await verifyUnitArtifactClosure({
      unitId,
      artifactDirectory,
      candidateRoot,
      artifactPaths: value.artifacts,
      policy: unitPolicies[unitId],
    });
    const artifacts = [];
    for (const artifactPath of value.artifacts) {
      const artifact = {
        path: artifactPath,
        sha256: await sha256File(artifactPath),
      };
      await verifyArtifact(candidateRoot, artifact);
      artifacts.push(artifact);
    }
    const next = structuredClone(state);
    const appendStreamArtifacts = await snapshotAppendStreams(candidateRoot);
    next.units[unitId] = {
      status: "complete",
      completed_at_utc: new Date().toISOString(),
      artifacts,
      append_stream_artifacts: appendStreamArtifacts,
      result: structuredClone(value.result ?? null),
    };
    await atomicJson(statePath, next);
    state = next;
    completed.push(unitId);
  }
  return {
    ok: true,
    state_path: statePath,
    completed,
    resumed,
  };
}
