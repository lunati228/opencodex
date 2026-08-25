#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protocolRelativePaths } from "../src/artifacts.mjs";
import {
  validateCampaignConfig,
  validateLiveConfig,
} from "../src/config.mjs";
import { buildBenchPlan, buildServerArgv } from "../src/live-argv.mjs";
import { runFinalCampaign } from "../src/final-campaign.mjs";
import { createFinalLiveRuntime } from "../src/final-live-runner.mjs";
import {
  harnessImplementationDigest,
  validateControlledArmManifest,
} from "../src/final-evidence.mjs";
import { runPreflight } from "../src/preflight.mjs";
import { loadQualitySuite } from "../src/quality-suite.mjs";
import { canonicalJson, sha256Bytes } from "../src/hash.mjs";
import { runShortSweep } from "../src/short-sweep-runner.mjs";
import { writeCampaignDecision } from "../src/campaign-decision.mjs";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (
    ![
      "dry-run",
      "preflight",
      "plan-live",
      "run-short-sweep",
      "run-final-campaign",
      "write-decision",
    ].includes(
      command,
    )
  ) {
    throw new Error(
      "USAGE: ornith-benchmark <dry-run|preflight|plan-live|run-short-sweep|run-final-campaign|write-decision> --config <path> [--hash-files] [--confirm-live] [--candidate <id> ...]",
    );
  }
  let configPath;
  let hashFiles = false;
  let confirmLive = false;
  const candidateIds = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--config") {
      configPath = rest[++index];
    } else if (argument === "--hash-files") {
      hashFiles = true;
    } else if (argument === "--confirm-live") {
      confirmLive = true;
    } else if (argument === "--candidate") {
      candidateIds.push(rest[++index]);
    } else {
      throw new Error(`UNKNOWN_ARGUMENT: ${argument}`);
    }
  }
  if (!configPath) throw new Error("MISSING_CONFIG_PATH");
  if (
    (command === "write-decision" && candidateIds.length < 1) ||
    (command !== "write-decision" && candidateIds.length > 0)
  ) {
    throw new Error("DECISION_CANDIDATE_SET_INVALID");
  }
  const liveCommand = ["run-short-sweep", "run-final-campaign"].includes(
    command,
  );
  if (liveCommand && !confirmLive) {
    throw new Error("LIVE_EXECUTION_REQUIRES_CONFIRM_LIVE");
  }
  if (liveCommand && hashFiles) {
    throw new Error("LIVE_COMMAND_FORBIDS_HASH_FILES");
  }
  if (!liveCommand && confirmLive) {
    throw new Error("CONFIRM_LIVE_ONLY_VALID_FOR_LIVE_COMMAND");
  }
  return { command, configPath, hashFiles, candidateIds };
}

async function main() {
  const {
    command,
    configPath,
    hashFiles,
    candidateIds,
  } = parseArguments(process.argv.slice(2));
  const config = validateCampaignConfig(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  if (command === "write-decision") {
    if (hashFiles) throw new Error("DECISION_COMMAND_FORBIDS_HASH_FILES");
    const result = await writeCampaignDecision({
      resultRoot: config.result_root,
      campaignId: config.campaign_id,
      candidateIds,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const liveCommand = ["run-short-sweep", "run-final-campaign"].includes(
    command,
  );
  if (command === "plan-live" || liveCommand) validateLiveConfig(config);
  if (
    command === "run-final-campaign" &&
    !["on", "off"].includes(config.live.moe_cache_mode)
  ) {
    throw new Error("FINAL_CAMPAIGN_REQUIRES_EXPLICIT_MOE_CACHE_MODE");
  }
  const preflight = await runPreflight(config, {
    hashFiles,
    hashBinaries: liveCommand,
  });
  const suite = await loadQualitySuite(config.quality_manifest);
  if (!suite.hash_valid) throw new Error("QUALITY_SUITE_HASH_MISMATCH");
  if (!suite.tool_schema_hash_valid) {
    throw new Error("TOOL_SCHEMA_HASH_MISMATCH");
  }
  if (
    config.expected?.quality_suite_sha256 &&
    suite.suite_sha256 !== config.expected.quality_suite_sha256
  ) {
    throw new Error("PINNED_QUALITY_SUITE_SHA256_MISMATCH");
  }
  if (suite.id !== "ornith-quality-v1" || suite.cases.length !== 17) {
    throw new Error("QUALITY_SUITE_ID_OR_COUNT_MISMATCH");
  }

  const livePlan =
    config.live &&
    (command === "dry-run" || command === "plan-live" || liveCommand)
      ? {
          cpu_moe_sweep: structuredClone(config.live.cpu_moe_sweep),
          short_sweep: buildBenchPlan({
            executable: config.llama_bench,
            model: config.model,
            candidate: config.candidate,
            kind: "short",
          }),
          final_bench: buildBenchPlan({
            executable: config.llama_bench,
            model: config.model,
            candidate: config.candidate,
            kind: "final",
          }),
          server: {
            executable: config.llama_server,
            args: buildServerArgv({
              model: config.model,
              serverModelId: config.live.server_model_id,
              port: config.live.server_port,
              candidate: config.candidate,
            }),
            shell: false,
          },
        }
      : null;
  if (command === "run-short-sweep") {
    const result = await runShortSweep({
      config,
      preflight,
      suite,
      cwd: process.cwd(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "run-final-campaign") {
    const runtimeIdentity = {
      llama_tag: config.candidate.llama_tag,
      llama_commit: config.candidate.llama_commit,
      runtime_manifest_sha256:
        preflight.runtime_evidence?.manifest_sha256 ?? null,
      runtime_content_set_sha256:
        preflight.runtime_evidence?.content_set_sha256 ?? null,
      bench_sha256: preflight.paths.llama_bench.sha256,
      server_sha256: preflight.paths.llama_server.sha256,
      model_sha256: preflight.hash_evidence?.model_sha256 ?? null,
      suite_sha256: suite.suite_sha256,
    };
    const armEvidence = await validateControlledArmManifest({
      config,
      manifestPath: config.live.arm_comparison_manifest,
      expectedSha256: config.live.arm_comparison_manifest_sha256,
      expectedRuntimeIdentitySha256: sha256Bytes(
        canonicalJson(runtimeIdentity),
      ),
    });
    const sourceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
    );
    const sourceNames = (await readdir(sourceRoot))
      .filter((name) => name.endsWith(".mjs"))
      .sort();
    const harnessSourceSha256 = await harnessImplementationDigest(
      [
        fileURLToPath(import.meta.url),
        ...sourceNames.map((name) => path.join(sourceRoot, name)),
      ],
    );
    const identity = {
      ...runtimeIdentity,
      controlled_arm_evidence: armEvidence,
    };
    const result = await runFinalCampaign({
      config,
      identity,
      harnessSourceSha256,
      armComparisonManifestSha256: armEvidence.manifest_sha256,
      cwd: process.cwd(),
      runtime: createFinalLiveRuntime({ config, preflight, suite }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const output = {
    ok: true,
    command,
    dry_run: command === "dry-run",
    writes_performed: 0,
    preflight,
    suite_id: suite.id,
    suite_sha256: suite.suite_sha256,
    case_count: suite.cases.length,
    category_counts: suite.category_counts,
    planned_artifacts: protocolRelativePaths(config.candidate_id),
    result_root: config.result_root,
    sandbox_root: config.sandbox_root,
    live_plan: livePlan,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
