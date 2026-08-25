import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadCompletedCampaignState,
  shortSweepArtifactPolicy,
} from "./campaign-state.mjs";
import { canonicalJson, sha256Bytes, sha256File } from "./hash.mjs";
import { resolveContainedPath } from "./security.mjs";

const DIGEST = /^[a-f0-9]{64}$/;

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function verifiedJsonEvidence(
  resultRoot,
  evidence,
  label,
  expectedPath,
) {
  if (
    !evidence ||
    typeof evidence.path !== "string" ||
    !path.isAbsolute(evidence.path) ||
    !DIGEST.test(evidence.sha256 ?? "")
  ) {
    throw new Error(`${label}_EVIDENCE_INVALID`);
  }
  const resolved = await resolveContainedPath(resultRoot, evidence.path);
  if (
    expectedPath !== undefined &&
    normalizedPath(resolved) !== normalizedPath(expectedPath)
  ) {
    throw new Error(`${label}_PATH_MISMATCH`);
  }
  const metadata = await lstat(resolved);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 4 * 1024 * 1024
  ) {
    throw new Error(`${label}_EVIDENCE_INVALID`);
  }
  if ((await sha256File(resolved)) !== evidence.sha256) {
    throw new Error(`${label}_HASH_MISMATCH`);
  }
  return JSON.parse(await readFile(resolved, "utf8"));
}

export async function harnessImplementationDigest(sourcePaths) {
  if (
    !Array.isArray(sourcePaths) ||
    sourcePaths.length < 1 ||
    sourcePaths.some((value) => typeof value !== "string" || !path.isAbsolute(value))
  ) {
    throw new Error("HARNESS_SOURCE_SET_INVALID");
  }
  const entries = [];
  for (const sourcePath of [...new Set(sourcePaths)].sort()) {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("HARNESS_SOURCE_NOT_REGULAR");
    }
    entries.push({
      path: path.basename(sourcePath),
      sha256: await sha256File(sourcePath),
    });
  }
  return sha256Bytes(canonicalJson(entries));
}

export async function validateControlledArmManifest({
  config,
  manifestPath,
  expectedSha256,
  expectedRuntimeIdentitySha256,
}) {
  if (
    typeof manifestPath !== "string" ||
    !path.isAbsolute(manifestPath) ||
    !DIGEST.test(expectedSha256 ?? "") ||
    (await sha256File(manifestPath)) !== expectedSha256
  ) {
    throw new Error("CONTROLLED_ARM_MANIFEST_HASH_MISMATCH");
  }
  if (!DIGEST.test(expectedRuntimeIdentitySha256 ?? "")) {
    throw new Error("CONTROLLED_ARM_RUNTIME_IDENTITY_INVALID");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schema_version !== "ornith-controlled-arms-1" ||
    manifest.campaign_id !== config.campaign_id ||
    manifest.finalist_candidate_id !== config.candidate_id
  ) {
    throw new Error("CONTROLLED_ARM_MANIFEST_IDENTITY_MISMATCH");
  }
  const campaign = await verifiedJsonEvidence(
    config.result_root,
    manifest.campaign,
    "CONTROLLED_ARM_CAMPAIGN",
    path.join(config.result_root, "campaign.json"),
  );
  if (
    campaign.schema_version !== "ornith-campaign-1" ||
    campaign.campaign_id !== config.campaign_id ||
    canonicalJson(campaign.cpu_moe_sweep) !== canonicalJson({
      values: config.live.cpu_moe_sweep.values,
      candidate_ids: config.live.cpu_moe_sweep.candidate_ids,
    })
  ) {
    throw new Error("CONTROLLED_ARM_CAMPAIGN_IDENTITY_MISMATCH");
  }
  const declaredIds = config.live.cpu_moe_sweep.candidate_ids;
  if (
    !Array.isArray(manifest.completed_sweep_states) ||
    manifest.completed_sweep_states.length !== declaredIds.length
  ) {
    throw new Error("COMPLETED_SWEEP_SET_MISMATCH");
  }
  const byId = new Map(
    manifest.completed_sweep_states.map((item) => [item?.candidate_id, item]),
  );
  if (
    byId.size !== declaredIds.length ||
    declaredIds.some((candidateId) => !byId.has(candidateId))
  ) {
    throw new Error("COMPLETED_SWEEP_SET_MISMATCH");
  }
  for (let candidateIndex = 0; candidateIndex < declaredIds.length; candidateIndex += 1) {
    const candidateId = declaredIds[candidateIndex];
    const entry = byId.get(candidateId);
    const candidateRoot = path.join(
      config.result_root,
      "candidates",
      candidateId,
    );
    const [state, recordedConfig] = await Promise.all([
      verifiedJsonEvidence(
        config.result_root,
        entry.state,
        "COMPLETED_SWEEP_STATE",
        path.join(candidateRoot, "campaign-state.json"),
      ),
      verifiedJsonEvidence(
        config.result_root,
        entry.config,
        "COMPLETED_SWEEP_CONFIG",
        path.join(candidateRoot, "config.json"),
      ),
    ]);
    const expectedCandidate = {
      ...structuredClone(config.candidate),
      n_cpu_moe: config.live.cpu_moe_sweep.values[candidateIndex],
    };
    const expectedSweep = {
      values: config.live.cpu_moe_sweep.values,
      candidate_ids: declaredIds,
      index: candidateIndex,
    };
    if (
      state.schema_version !== "ornith-campaign-state-1" ||
      state.campaign_id !== config.campaign_id ||
      state.candidate_id !== candidateId ||
      state.config_sha256 !==
        sha256Bytes(canonicalJson(recordedConfig)) ||
      state.units?.["sweep.short"]?.status !== "complete" ||
      !Array.isArray(state.units["sweep.short"].artifacts) ||
      Object.keys(state.units).length !== 1 ||
      state.identity_sha256 !==
        sha256Bytes(canonicalJson(campaign.identity)) ||
      state.comparison_sha256 !== campaign.cpu_moe_comparison_sha256 ||
      recordedConfig.campaign_id !== config.campaign_id ||
      recordedConfig.candidate_id !== candidateId ||
      typeof recordedConfig.result_root !== "string" ||
      !path.isAbsolute(recordedConfig.result_root) ||
      normalizedPath(recordedConfig.result_root) !==
        normalizedPath(config.result_root) ||
      canonicalJson(recordedConfig.live?.cpu_moe_sweep) !==
        canonicalJson(expectedSweep) ||
      canonicalJson(recordedConfig.candidate) !==
        canonicalJson(expectedCandidate)
    ) {
      throw new Error(`COMPLETED_SWEEP_INVALID: ${candidateId}`);
    }
    const completedState = await loadCompletedCampaignState(entry.state.path, {
      campaignId: config.campaign_id,
      candidateId,
      configSha256: sha256Bytes(canonicalJson(recordedConfig)),
      identitySha256: sha256Bytes(canonicalJson(campaign.identity)),
      comparisonSha256: campaign.cpu_moe_comparison_sha256,
      artifactPolicy: shortSweepArtifactPolicy(
        config.result_root,
        candidateRoot,
      ),
    });
    if (canonicalJson(completedState) !== canonicalJson(state)) {
      throw new Error(`COMPLETED_SWEEP_STATE_CHANGED: ${candidateId}`);
    }
  }
  if (!Array.isArray(manifest.arms) || manifest.arms.length !== 2) {
    throw new Error("CONTROLLED_ARM_SET_INVALID");
  }
  const modes = manifest.arms.map(({ moe_cache_mode: mode }) => mode).sort();
  if (JSON.stringify(modes) !== JSON.stringify(["off", "on"])) {
    throw new Error("CONTROLLED_ARM_SET_INVALID");
  }
  const comparableArms = manifest.arms.map((arm) => {
    const comparable = structuredClone(arm);
    delete comparable.moe_cache_mode;
    return comparable;
  });
  if (
    canonicalJson(comparableArms[0]) !== canonicalJson(comparableArms[1]) ||
    canonicalJson(comparableArms[0].candidate) !==
      canonicalJson(config.candidate) ||
    comparableArms[0].runtime_identity_sha256 !==
      expectedRuntimeIdentitySha256
  ) {
    throw new Error("CONTROLLED_ARM_HIDDEN_DIFFERENCE");
  }
  return {
    manifest_path: manifestPath,
    manifest_sha256: expectedSha256,
    finalist_candidate_id: manifest.finalist_candidate_id,
    moe_cache_modes: modes,
    comparable_arm_sha256: sha256Bytes(canonicalJson(comparableArms[0])),
  };
}
