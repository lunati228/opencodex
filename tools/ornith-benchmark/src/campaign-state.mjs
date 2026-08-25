import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./hash.mjs";
import { resolveContainedPath } from "./security.mjs";

function identityMatches(state, expected) {
  return (
    state.campaign_id === expected.campaignId &&
    state.candidate_id === expected.candidateId &&
    state.config_sha256 === expected.configSha256 &&
    state.identity_sha256 === expected.identitySha256 &&
    state.comparison_sha256 === expected.comparisonSha256
  );
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, filePath);
}

export function createCampaignState({
  campaignId,
  candidateId,
  configSha256,
  identitySha256,
  comparisonSha256,
}) {
  return {
    schema_version: "ornith-campaign-state-1",
    campaign_id: campaignId,
    candidate_id: candidateId,
    config_sha256: configSha256,
    identity_sha256: identitySha256,
    comparison_sha256: comparisonSha256,
    units: {},
  };
}

export async function initializeCampaignState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  });
  return state;
}

export async function markUnitComplete(
  statePath,
  state,
  unitId,
  artifactPaths,
  artifactPolicy,
) {
  if (typeof unitId !== "string" || unitId.length === 0) throw new Error("INVALID_STATE_UNIT");
  if (state.units[unitId]) throw new Error("STATE_UNIT_ALREADY_RECORDED");
  const unsignedArtifacts = artifactPaths.map((artifactPath) => ({
    path: artifactPath,
    sha256: "0".repeat(64),
  }));
  await validateArtifactSetBeforeHash(unsignedArtifacts, artifactPolicy);
  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    artifacts.push({ path: artifactPath, sha256: await sha256File(artifactPath) });
  }
  const next = structuredClone(state);
  next.units[unitId] = {
    status: "complete",
    completed_at_utc: new Date().toISOString(),
    artifacts,
  };
  await atomicWriteJson(statePath, next);
  return next;
}

function normalized(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function rejectReparseTraversal(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("STATE_ARTIFACT_CONTAINMENT_FAILED");
  }
  let cursor = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor);
    if (
      metadata.isSymbolicLink() ||
      normalized(await realpath(cursor)) !== normalized(cursor)
    ) {
      throw new Error("STATE_ARTIFACT_REPARSE_FORBIDDEN");
    }
  }
}

async function validateArtifactSetBeforeHash(artifacts, policy) {
  if (
    !policy ||
    !path.isAbsolute(policy.resultRoot) ||
    !path.isAbsolute(policy.candidateRoot) ||
    !Array.isArray(policy.allowed) ||
    artifacts.length !== policy.allowed.length
  ) {
    throw new Error("INVALID_ARTIFACT_POLICY");
  }
  const allowed = new Map(
    policy.allowed.map(({ path: filePath, maxBytes }) => [
      normalized(filePath),
      { path: filePath, maxBytes },
    ]),
  );
  if (allowed.size !== policy.allowed.length) {
    throw new Error("DUPLICATE_ARTIFACT_POLICY_PATH");
  }
  const seen = new Set();
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      !path.isAbsolute(artifact.path) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
    ) {
      throw new Error("INVALID_STATE_ARTIFACT");
    }
    const key = normalized(artifact.path);
    const rule = allowed.get(key);
    if (!rule || seen.has(key)) throw new Error("STATE_ARTIFACT_NOT_ALLOWLISTED");
    seen.add(key);
    await rejectReparseTraversal(policy.resultRoot, artifact.path);
    const contained = await resolveContainedPath(policy.resultRoot, artifact.path);
    if (normalized(contained) !== key) throw new Error("STATE_ARTIFACT_CONTAINMENT_FAILED");
    const metadata = await lstat(contained);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !Number.isSafeInteger(rule.maxBytes) ||
      rule.maxBytes < 0 ||
      metadata.size > rule.maxBytes
    ) {
      throw new Error("STATE_ARTIFACT_TYPE_OR_SIZE_INVALID");
    }
  }
  if (seen.size !== allowed.size) throw new Error("STATE_ARTIFACT_SET_INCOMPLETE");
}

async function verifyUnits(state, policy) {
  for (const unit of Object.values(state.units)) {
    if (unit.status !== "complete" || !Array.isArray(unit.artifacts)) {
      throw new Error("RESUME_PARTIAL_UNIT_REJECTED");
    }
    await validateArtifactSetBeforeHash(unit.artifacts, policy);
    for (const artifact of unit.artifacts) {
      if ((await sha256File(artifact.path)) !== artifact.sha256) {
        throw new Error(`RESUME_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
      }
    }
  }
}

async function validateStatePathBeforeRead(statePath, policy) {
  if (
    !policy ||
    !path.isAbsolute(statePath) ||
    normalized(statePath) !==
      normalized(path.join(policy.candidateRoot, "campaign-state.json"))
  ) {
    throw new Error("INVALID_CAMPAIGN_STATE_PATH");
  }
  await rejectReparseTraversal(policy.resultRoot, statePath);
  const contained = await resolveContainedPath(policy.resultRoot, statePath);
  const metadata = await lstat(contained);
  if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
    throw new Error("CAMPAIGN_STATE_TYPE_OR_SIZE_INVALID");
  }
}

export async function loadCampaignState(statePath, expected) {
  await validateStatePathBeforeRead(statePath, expected.artifactPolicy);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (
    state.schema_version !== "ornith-campaign-state-1" ||
    !identityMatches(state, expected)
  ) {
    throw new Error("RESUME_IDENTITY_MISMATCH");
  }
  await verifyUnits(state, expected.artifactPolicy);
  return state;
}

export async function loadCompletedCampaignState(statePath, expected) {
  await validateStatePathBeforeRead(statePath, expected.artifactPolicy);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (
    state.schema_version !== "ornith-campaign-state-1" ||
    state.campaign_id !== expected.campaignId ||
    state.candidate_id !== expected.candidateId ||
    (expected.configSha256 !== undefined &&
      state.config_sha256 !== expected.configSha256) ||
    state.identity_sha256 !== expected.identitySha256 ||
    state.comparison_sha256 !== expected.comparisonSha256
  ) {
    throw new Error("RESUME_IDENTITY_MISMATCH");
  }
  await verifyUnits(state, expected.artifactPolicy);
  return state;
}

export function shortSweepArtifactPolicy(resultRoot, candidateRoot) {
  const allowed = [
    [path.join(resultRoot, "campaign.json"), 4 * 1024 * 1024],
    ...[
      "versions.txt",
      "hashes.sha256",
      "devices.txt",
      "gpu-topology.txt",
      "host.txt",
    ].map((name) => [
      path.join(resultRoot, "inventory", name),
      4 * 1024 * 1024,
    ]),
    [path.join(candidateRoot, "config.json"), 4 * 1024 * 1024],
    [path.join(candidateRoot, "telemetry.csv"), 64 * 1024 * 1024],
    [path.join(candidateRoot, "sweep", "summary.json"), 8 * 1024 * 1024],
  ];
  for (const id of ["pp2k", "tg256-d2k"]) {
    allowed.push(
      [path.join(candidateRoot, "sweep", `${id}.raw.json`), 64 * 1024 * 1024],
      [path.join(candidateRoot, "sweep", `${id}.stderr.txt`), 16 * 1024 * 1024],
      [path.join(candidateRoot, "sweep", `${id}.command.json`), 1024 * 1024],
    );
  }
  for (const name of [
    "nvidia-query.stdout.csv",
    "nvidia-query.stderr.txt",
    "nvidia-dmon.stdout.txt",
    "nvidia-dmon.stderr.txt",
    "host-monitor.stdout.csv",
    "host-monitor.stderr.txt",
  ]) {
    allowed.push([
      path.join(candidateRoot, "sweep", "telemetry", name),
      64 * 1024 * 1024,
    ]);
  }
  return {
    resultRoot,
    candidateRoot,
    allowed: allowed.map(([filePath, maxBytes]) => ({
      path: filePath,
      maxBytes,
    })),
  };
}
