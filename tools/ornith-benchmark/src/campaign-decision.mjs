import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { writeDerivedJson } from "./artifacts.mjs";
import {
  loadCompletedCampaignState,
  shortSweepArtifactPolicy,
} from "./campaign-state.mjs";
import { FINAL_UNIT_POLICIES } from "./final-campaign.mjs";
import { deriveCandidateGateFromSummaries } from "./final-live-runner.mjs";
import {
  canonicalJson,
  sha256Bytes,
  sha256File,
} from "./hash.mjs";
import { validateResult } from "./schema.mjs";
import { resolveContainedPath } from "./security.mjs";

const DECISION_RANK = Object.freeze({
  INVALID: 0,
  REMOVE: 1,
  FAIL: 2,
  CONDITIONAL_INTEGRATE: 3,
  INTEGRATE: 4,
  STRONG_INTEGRATE: 5,
});

function percentile95(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return finite[Math.ceil(finite.length * 0.95) - 1];
}

function candidateTieBreakers(result) {
  const rounds = (result.server?.sustained?.cases ?? [])
    .flatMap(({ run }) => run?.rounds ?? []);
  const telemetry = result.telemetry_summary?.sustained;
  const peakTemperature = Math.max(
    ...Object.values(telemetry?.by_gpu ?? {})
      .map(({ temperature_c_max: value }) => value)
      .filter(Number.isFinite),
    Number.NEGATIVE_INFINITY,
  );
  return {
    quality_passed: result.quality.passed,
    sustained_ttft_ms_p95: percentile95(
      rounds.map(({ ttft_ms: value }) => value),
    ),
    sustained_total_wall_ms_p95: percentile95(
      rounds.map(({ total_wall_ms: value }) => value),
    ),
    tool_latency_ms_p95: percentile95(
      rounds.map(({ tool_latency_ms_sum: value }) => value),
    ),
    peak_temperature_c:
      Number.isFinite(peakTemperature) ? peakTemperature : null,
    peak_host_committed_pct:
      telemetry?.host_summary?.committed_pct_max ?? null,
    sustained_median_decode_ts:
      result.gate.sustained_median_decode_ts ?? null,
  };
}

function compareNullable(left, right, direction) {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);
  if (leftFinite !== rightFinite) return leftFinite ? -1 : 1;
  if (!leftFinite) return 0;
  return direction * (left - right);
}

function compareCandidates(left, right) {
  const rankDifference =
    DECISION_RANK[right.decision] - DECISION_RANK[left.decision];
  if (rankDifference !== 0) return rankDifference;
  const qualityDifference =
    right.tie_breakers.quality_passed - left.tie_breakers.quality_passed;
  if (qualityDifference !== 0) return qualityDifference;
  for (const field of [
    "sustained_ttft_ms_p95",
    "sustained_total_wall_ms_p95",
    "tool_latency_ms_p95",
    "peak_temperature_c",
    "peak_host_committed_pct",
  ]) {
    const difference = compareNullable(
      left.tie_breakers[field],
      right.tie_breakers[field],
      1,
    );
    if (difference !== 0) return difference;
  }
  const speedDifference = compareNullable(
    left.tie_breakers.sustained_median_decode_ts,
    right.tie_breakers.sustained_median_decode_ts,
    -1,
  );
  if (speedDifference !== 0) return speedDifference;
  return left.candidate_id.localeCompare(right.candidate_id);
}

async function verifyResultClosure(resultRoot, candidateRoot, result) {
  for (const [relative, expectedSha256] of Object.entries(result.raw_sha256)) {
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("CAMPAIGN_DECISION_RESULT_RAW_PATH_INVALID");
    }
    const artifactPath = await resolveContainedPath(candidateRoot, relative);
    if ((await sha256File(artifactPath)) !== expectedSha256) {
      throw new Error("CAMPAIGN_DECISION_RESULT_RAW_HASH_MISMATCH");
    }
    await resolveContainedPath(resultRoot, artifactPath);
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readRegularJson(filePath, maximumBytes = 64 * 1024 * 1024) {
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > maximumBytes
  ) {
    throw new Error("CAMPAIGN_DECISION_EVIDENCE_FILE_INVALID");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function verifyArtifact(resultRoot, artifact) {
  if (
    typeof artifact?.path !== "string" ||
    !path.isAbsolute(artifact.path) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
  ) {
    throw new Error("CAMPAIGN_DECISION_STATE_ARTIFACT_INVALID");
  }
  const filePath = await resolveContainedPath(resultRoot, artifact.path);
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 64 * 1024 * 1024 ||
    (await sha256File(filePath)) !== artifact.sha256
  ) {
    throw new Error("CAMPAIGN_DECISION_STATE_ARTIFACT_HASH_MISMATCH");
  }
  return filePath;
}

const FINAL_UNIT_DIRECTORIES = Object.freeze({
  "final-bench": ["final"],
  "cold-1": ["server", "cold", "run-1"],
  "cold-2": ["server", "cold", "run-2"],
  "cold-3": ["server", "cold", "run-3"],
  "warm-quality": ["server", "warm"],
  sustained: ["server", "sustained"],
});

async function verifyFinalCampaignState({
  resultRoot,
  candidateRoot,
  resultPath,
}) {
  const statePath = path.join(candidateRoot, "final-campaign-state.json");
  const state = await readRegularJson(statePath, 4 * 1024 * 1024);
  if (
    state.schema_version !== "ornith-final-campaign-state-2" ||
    !/^[a-f0-9]{64}$/.test(state.identity_sha256 ?? "") ||
    !state.units ||
    typeof state.units !== "object"
  ) {
    throw new Error("CAMPAIGN_DECISION_FINAL_STATE_INVALID");
  }
  const evidencePaths = [statePath];
  let resultArtifact = null;
  for (const [unitId, directorySegments] of Object.entries(
    FINAL_UNIT_DIRECTORIES,
  )) {
    const unit = state.units[unitId];
    const policy = FINAL_UNIT_POLICIES[unitId];
    if (
      unit?.status !== "complete" ||
      !Array.isArray(unit.artifacts) ||
      unit.artifacts.length < 1
    ) {
      throw new Error(`CAMPAIGN_DECISION_FINAL_UNIT_INVALID: ${unitId}`);
    }
    const byPath = new Map(
      unit.artifacts.map((artifact) => [
        normalizedPath(artifact?.path ?? ""),
        artifact,
      ]),
    );
    if (byPath.size !== unit.artifacts.length) {
      throw new Error(`CAMPAIGN_DECISION_FINAL_UNIT_DUPLICATE: ${unitId}`);
    }
    const artifactDirectory = path.join(candidateRoot, ...directorySegments);
    for (const relative of policy.required) {
      if (!byPath.has(normalizedPath(path.join(artifactDirectory, relative)))) {
        throw new Error(
          `CAMPAIGN_DECISION_FINAL_UNIT_REQUIRED_MISSING: ${unitId}:${relative}`,
        );
      }
    }
    for (const rule of policy.dynamic) {
      const matches = unit.artifacts.filter(({ path: artifactPath }) => {
        const relative = path
          .relative(artifactDirectory, artifactPath)
          .replaceAll("\\", "/");
        return (
          relative.length > 0 &&
          !relative.startsWith("../") &&
          relative.endsWith(rule.suffix) &&
          !policy.required.includes(relative)
        );
      });
      if (matches.length < rule.minimum) {
        throw new Error(
          `CAMPAIGN_DECISION_FINAL_UNIT_DYNAMIC_MISSING: ${unitId}`,
        );
      }
    }
    for (const relative of policy.candidate_required ?? []) {
      const requiredPath = path.join(candidateRoot, relative);
      const artifact = byPath.get(normalizedPath(requiredPath));
      if (!artifact) {
        throw new Error(
          `CAMPAIGN_DECISION_FINAL_UNIT_REQUIRED_MISSING: ${unitId}:${relative}`,
        );
      }
      if (normalizedPath(requiredPath) === normalizedPath(resultPath)) {
        resultArtifact = artifact;
      }
    }
    for (const artifact of unit.artifacts) {
      evidencePaths.push(await verifyArtifact(resultRoot, artifact));
    }
  }
  const sustainedStreams =
    state.units.sustained?.append_stream_artifacts;
  if (!Array.isArray(sustainedStreams) || sustainedStreams.length !== 2) {
    throw new Error("CAMPAIGN_DECISION_APPEND_STREAM_STATE_INVALID");
  }
  for (const artifact of sustainedStreams) {
    evidencePaths.push(await verifyArtifact(resultRoot, artifact));
  }
  if (
    !resultArtifact ||
    resultArtifact.sha256 !== await sha256File(resultPath)
  ) {
    throw new Error("CAMPAIGN_DECISION_RESULT_NOT_BOUND_TO_FINAL_STATE");
  }
  return { statePath, evidencePaths };
}

async function verifyShortSweepState({
  resultRoot,
  candidateRoot,
  campaignId,
  candidateId,
  result,
}) {
  const configPath = path.join(candidateRoot, "config.json");
  const statePath = path.join(candidateRoot, "campaign-state.json");
  const campaignPath = path.join(resultRoot, "campaign.json");
  const [config, campaign] = await Promise.all([
    readRegularJson(configPath, 4 * 1024 * 1024),
    readRegularJson(campaignPath, 4 * 1024 * 1024),
  ]);
  const resultCandidate = structuredClone(result.config);
  delete resultCandidate.use_mmap;
  delete resultCandidate.use_direct_io;
  if (
    config.campaign_id !== campaignId ||
    config.candidate_id !== candidateId ||
    campaign.campaign_id !== campaignId ||
    canonicalJson(config.candidate) !== canonicalJson(resultCandidate)
  ) {
    throw new Error("CAMPAIGN_DECISION_SHORT_STATE_IDENTITY_MISMATCH");
  }
  const state = await loadCompletedCampaignState(statePath, {
    campaignId,
    candidateId,
    configSha256: sha256Bytes(canonicalJson(config)),
    identitySha256: sha256Bytes(canonicalJson(campaign.identity)),
    comparisonSha256: campaign.cpu_moe_comparison_sha256,
    artifactPolicy: shortSweepArtifactPolicy(resultRoot, candidateRoot),
  });
  if (
    Object.keys(state.units).length !== 1 ||
    state.units["sweep.short"]?.status !== "complete"
  ) {
    throw new Error("CAMPAIGN_DECISION_SHORT_STATE_INCOMPLETE");
  }
  return {
    statePath,
    evidencePaths: [
      statePath,
      ...state.units["sweep.short"].artifacts.map(({ path: filePath }) =>
        filePath),
    ],
  };
}

async function recomputeAndVerifyCandidateGate(candidateRoot, result) {
  const readSummary = (...segments) =>
    readRegularJson(path.join(candidateRoot, ...segments));
  const [finalSummary, warmSummary, sustainedSummary, ...coldSummaries] =
    await Promise.all([
      readSummary("final", "summary.json"),
      readSummary("server", "warm", "summary.json"),
      readSummary("server", "sustained", "summary.json"),
      ...[1, 2, 3].map((index) =>
        readSummary("server", "cold", `run-${index}`, "summary.json")),
    ]);
  const recomputed = deriveCandidateGateFromSummaries({
    finalSummary,
    warmSummary,
    coldSummaries,
    sustainedSummary,
  });
  const expectedBenchmarks = Object.fromEntries(
    finalSummary.value.map(({ id, samples_ts, samples_ns, summary }) => [
      id,
      {
        samples_ts,
        samples_ns,
        ...summary,
      },
    ]),
  );
  const expectedServer = {
    cold: coldSummaries.map(({ value }) => value.cases[0]),
    warm: { cases: warmSummary.value.cases },
    sustained: { cases: sustainedSummary.value.cases },
    sustained_scoring_samples: recomputed.sustainedScoringSamples,
  };
  const expectedTelemetry = {
    final: finalSummary.telemetry,
    cold: coldSummaries.map(({ telemetry }) => telemetry),
    warm: warmSummary.telemetry,
    sustained: sustainedSummary.telemetry,
  };
  if (
    canonicalJson(result.llama_bench.final) !==
      canonicalJson(expectedBenchmarks) ||
    canonicalJson(result.server) !== canonicalJson(expectedServer) ||
    canonicalJson(result.telemetry_summary) !==
      canonicalJson(expectedTelemetry)
  ) {
    throw new Error("CAMPAIGN_DECISION_RESULT_EVIDENCE_MISMATCH");
  }
  if (
    canonicalJson(result.gate) !== canonicalJson(recomputed.gate) ||
    canonicalJson(result.quality) !== canonicalJson(recomputed.quality) ||
    canonicalJson(result.server.sustained_scoring_samples) !==
      canonicalJson(recomputed.sustainedScoringSamples)
  ) {
    throw new Error("CAMPAIGN_DECISION_RECOMPUTED_GATE_MISMATCH");
  }
}

export async function writeCampaignDecision({
  resultRoot,
  campaignId,
  candidateIds,
}) {
  if (
    typeof resultRoot !== "string" ||
    !path.isAbsolute(resultRoot) ||
    typeof campaignId !== "string" ||
    campaignId.length === 0 ||
    !Array.isArray(candidateIds) ||
    candidateIds.length < 1 ||
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.some((candidateId) =>
      typeof candidateId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(candidateId))
  ) {
    throw new Error("CAMPAIGN_DECISION_INPUT_INVALID");
  }
  const decisionEvidencePaths = new Set();
  const ranking = [];
  for (const candidateId of candidateIds) {
    const candidateRoot = path.join(resultRoot, "candidates", candidateId);
    const resultPath = await resolveContainedPath(
      resultRoot,
      path.join(candidateRoot, "result.json"),
    );
    const metadata = await lstat(resultPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 64 * 1024 * 1024
    ) {
      throw new Error("CAMPAIGN_DECISION_RESULT_INVALID");
    }
    const result = validateResult(
      JSON.parse(await readFile(resultPath, "utf8")),
    );
    if (
      result.campaign_id !== campaignId ||
      result.candidate_id !== candidateId ||
      result.status !== "complete" ||
      !Object.hasOwn(DECISION_RANK, result.gate?.decision)
    ) {
      throw new Error("CAMPAIGN_DECISION_RESULT_IDENTITY_MISMATCH");
    }
    await verifyResultClosure(resultRoot, candidateRoot, result);
    const [finalState, shortState] = await Promise.all([
      verifyFinalCampaignState({
        resultRoot,
        candidateRoot,
        resultPath,
      }),
      verifyShortSweepState({
        resultRoot,
        candidateRoot,
        campaignId,
        candidateId,
        result,
      }),
    ]);
    const candidateEvidence = [
      ...finalState.evidencePaths,
      ...shortState.evidencePaths,
    ];
    for (const evidencePath of candidateEvidence) {
      decisionEvidencePaths.add(path.resolve(evidencePath));
      const relative = path
        .relative(candidateRoot, evidencePath)
        .replaceAll("\\", "/");
      if (
        relative.length === 0 ||
        relative.startsWith("../") ||
        path.isAbsolute(relative) ||
        relative === "final-campaign-state.json" ||
        relative === "result.json"
      ) {
        continue;
      }
      const expected = result.raw_sha256[relative];
      if (
        expected === undefined ||
        expected !== await sha256File(evidencePath)
      ) {
        throw new Error("CAMPAIGN_DECISION_RESULT_CLOSURE_INCOMPLETE");
      }
    }
    await recomputeAndVerifyCandidateGate(candidateRoot, result);
    decisionEvidencePaths.add(path.resolve(resultPath));
    ranking.push({
      candidate_id: candidateId,
      decision: result.gate.decision,
      experimental: Boolean(result.config.experimental),
      tie_breakers: candidateTieBreakers(result),
    });
  }
  ranking.sort(compareCandidates);
  const selected = ranking[0];
  const decisionPath = path.join(resultRoot, "decision.json");
  await writeDerivedJson(
    decisionPath,
    {
      schema_version: "ornith-campaign-decision-1",
      campaign_id: campaignId,
      status: "complete",
      candidate_ids: [...candidateIds],
      selected_candidate_id: selected.candidate_id,
      selected_decision: selected.decision,
      ranking,
    },
    [...decisionEvidencePaths].sort(),
    { keyRoot: resultRoot },
  );
  return {
    decision_path: decisionPath,
    selected_candidate_id: selected.candidate_id,
    selected_decision: selected.decision,
  };
}
