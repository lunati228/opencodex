import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ROUNDS_CSV_HEADER,
  TELEMETRY_CSV_HEADER,
} from "../src/artifacts.mjs";
import { writeCampaignDecision } from "../src/campaign-decision.mjs";
import {
  CAMPAIGN_INVENTORY_NAMES,
} from "../src/campaign-inventory.mjs";
import { shortSweepArtifactPolicy } from "../src/campaign-state.mjs";
import { FINAL_UNIT_POLICIES } from "../src/final-campaign.mjs";
import { tempRoot } from "./temp-root.mjs";
import {
  deriveCandidateGateFromSummaries,
} from "../src/final-live-runner.mjs";
import {
  canonicalJson,
  sha256Bytes,
  sha256File,
} from "../src/hash.mjs";

const UNIT_DIRECTORIES = Object.freeze({
  "final-bench": ["final"],
  "cold-1": ["server", "cold", "run-1"],
  "cold-2": ["server", "cold", "run-2"],
  "cold-3": ["server", "cold", "run-3"],
  "warm-quality": ["server", "warm"],
  sustained: ["server", "sustained"],
});

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function regularFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await regularFiles(absolute, relative));
    } else if (entry.isFile()) {
      output.push({ relative, absolute });
    }
  }
  return output;
}

function contextBudget() {
  return {
    fits: true,
    prompt_tokens: 128,
    reserved_tokens: 1024,
    context_size: 8192,
    headroom_tokens: 7040,
    provenance: "llama-server-b10099-/tokenize",
    rendered_prompt_sha256: "f".repeat(64),
    template_provenance: "llama-server-b10099-/apply-template",
  };
}

function protocolRound(phase, caseId) {
  return {
    phase,
    case_id: caseId,
    round_index: 0,
    started_at_utc: "2026-07-26T00:00:00.000Z",
    request_start_ns: 1,
    request_sent_ns: 2,
    first_sse_event_ns: 3,
    first_output_ns: 4,
    response_end_ns: 5,
    cache_n: 0,
    prompt_n: 128,
    prompt_ms: 1_000,
    prefill_tok_s: 128,
    predicted_n: 64,
    predicted_ms: 16_000,
    decode_tok_s: 4,
    ttft_ms: 0.000003,
    post_upload_ttft_ms: 0.000002,
    total_wall_ms: 0.000004,
    reasoning_tokens: 11,
    answer_tokens: 7,
    tool_calls: [],
    tool_latency_ms_sum: 10,
    tool_round_wall_ms: 10,
    normal_speed_sample: true,
    outcome: "pass",
    abort_reason: null,
    context_budget: contextBudget(),
  };
}

function benchWorkload(id) {
  return {
    id,
    samples_ts: [4, 4, 4],
    samples_ns: [1, 1, 1],
    summary: {
      repetitions: 3,
      median_ts: 4,
      minimum_ts: 4,
      maximum_ts: 4,
      median_absolute_deviation_ts: 0,
      arithmetic_mean_ts: 4,
    },
  };
}

function tokenCounts() {
  return {
    reasoning: {
      count: 11,
      provenance: "test-tokenizer",
      sha256: "a".repeat(64),
    },
    answer: {
      count: 7,
      provenance: "test-tokenizer",
      sha256: "b".repeat(64),
    },
    tool_calls: {
      count: 0,
      provenance: null,
      sha256: "c".repeat(64),
    },
    provenance: "test-tokenizer",
  };
}

function qualityCases() {
  const categories = [
    ...Array(6).fill("edit"),
    ...Array(2).fill("debug"),
    ...Array(3).fill("tool_chain"),
    ...Array(2).fill("ambiguous"),
    ...Array(2).fill("stop_ask"),
    ...Array(2).fill("second_attempt"),
  ];
  return categories.map((category, index) => ({
    case_id: `E-${String(index + 1).padStart(2, "0")}`,
    category,
    score: { passed: true },
    run: {
      tool_round_count: 0,
      rounds: [protocolRound("warm", `E-${String(index + 1).padStart(2, "0")}`)],
      token_counts: tokenCounts(),
    },
  }));
}

function sustainedCases() {
  return Array.from({ length: 10 }, (_, index) => ({
    case_id:
      index < 3
        ? `E-${String(index + 1).padStart(2, "0")}`
        : `T-${String(index + 1).padStart(2, "0")}`,
    category: index < 3 ? "edit" : "tool_chain",
    run: {
      tool_round_count: index === 3 ? 3 : 1,
      rounds: [
        protocolRound(
          "sustained",
          index < 3 ? `E-0${index + 1}` : `T-${String(index + 1).padStart(2, "0")}`,
        ),
      ],
      token_counts: tokenCounts(),
    },
  }));
}

async function ensureCampaignFiles(root, candidateIds) {
  const campaign = {
    schema_version: "ornith-campaign-1",
    campaign_id: "campaign",
    identity: { runtime: "pinned" },
    cpu_moe_sweep: {
      values: candidateIds.map(() => 60),
      candidate_ids: candidateIds,
    },
    cpu_moe_comparison_sha256: "e".repeat(64),
  };
  await writeJson(path.join(root, "campaign.json"), campaign);
  await mkdir(path.join(root, "inventory"), { recursive: true });
  for (const name of CAMPAIGN_INVENTORY_NAMES) {
    await writeFile(path.join(root, "inventory", name), `${name}\n`);
  }
  return campaign;
}

async function writeUnitFiles(candidateRoot, summaries) {
  for (const [unitId, segments] of Object.entries(UNIT_DIRECTORIES)) {
    const directory = path.join(candidateRoot, ...segments);
    const policy = FINAL_UNIT_POLICIES[unitId];
    await mkdir(directory, { recursive: true });
    for (const relative of policy.required) {
      const filePath = path.join(directory, relative);
      await mkdir(path.dirname(filePath), { recursive: true });
      if (relative === "summary.json") {
        const summary =
          unitId === "final-bench"
            ? summaries.final
            : unitId === "warm-quality"
              ? summaries.warm
              : unitId === "sustained"
                ? summaries.sustained
                : summaries.cold[Number(unitId.at(-1)) - 1];
        await writeJson(filePath, summary);
      } else {
        await writeFile(filePath, `${unitId}:${relative}\n`);
      }
    }
    for (const rule of policy.dynamic) {
      for (let index = 0; index < rule.minimum; index += 1) {
        await writeFile(
          path.join(directory, `dynamic-${index}${rule.suffix}`),
          "sse\n",
        );
      }
    }
  }
}

async function artifactEvidence(paths) {
  return Promise.all(paths.map(async (filePath) => ({
    path: filePath,
    sha256: await sha256File(filePath),
  })));
}

async function writeCandidate(root, campaign, candidateId, {
  decision,
  quality,
  sustainedMedian,
}) {
  const candidateIds = campaign.cpu_moe_sweep.candidate_ids;
  const candidateIndex = candidateIds.indexOf(candidateId);
  const candidateRoot = path.join(root, "candidates", candidateId);
  await mkdir(candidateRoot, { recursive: true });
  const candidate = {
    llama_tag: "b10099",
    llama_commit: "a".repeat(40),
    load_mode: "mmap",
    backend_devices: ["CUDA0", "CUDA1"],
    device_order: ["GPU-A", "GPU-B"],
    split_mode: "layer",
    experimental: false,
    tensor_split: [1, 1],
    n_gpu_layers: 0,
    n_cpu_moe: 60,
    fit: "off",
    spec_type: "none",
    ctx_size: 8192,
    generation_cap: 1024,
    batch: 512,
    ubatch: 128,
    threads: 8,
    threads_batch: 8,
    cpu_mask: "0xff",
    cpu_strict: false,
    priority: 0,
    poll: 50,
    flash_attn: "on",
    cache_type_k: "q8_0",
    cache_type_v: "q8_0",
    kv_offload: true,
    op_offload: true,
    cache_ram_mib: 0,
    reasoning_format: "auto",
    reasoning_budget: 1024,
    sampling: {
      seed: 1,
      temperature: 0,
      top_p: 1,
      min_p: 0,
      top_k: 40,
    },
  };
  const config = {
    campaign_id: "campaign",
    candidate_id: candidateId,
    result_root: root,
    live: {
      cpu_moe_sweep: {
        values: campaign.cpu_moe_sweep.values,
        candidate_ids: candidateIds,
        index: candidateIndex,
      },
    },
    candidate,
  };
  const configPath = path.join(candidateRoot, "config.json");
  await writeJson(configPath, config);
  await writeFile(
    path.join(candidateRoot, "rounds.csv"),
    `${ROUNDS_CSV_HEADER}\n`,
  );
  await writeFile(
    path.join(candidateRoot, "telemetry.csv"),
    `${TELEMETRY_CSV_HEADER}\n`,
  );

  const policy = shortSweepArtifactPolicy(root, candidateRoot);
  for (const { path: artifactPath } of policy.allowed) {
    try {
      await readFile(artifactPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `short:${path.basename(artifactPath)}\n`);
    }
  }
  const shortArtifacts = await artifactEvidence(
    policy.allowed.map(({ path: artifactPath }) => artifactPath),
  );
  const shortStatePath = path.join(candidateRoot, "campaign-state.json");
  await writeJson(shortStatePath, {
    schema_version: "ornith-campaign-state-1",
    campaign_id: "campaign",
    candidate_id: candidateId,
    config_sha256: sha256Bytes(canonicalJson(config)),
    identity_sha256: sha256Bytes(canonicalJson(campaign.identity)),
    comparison_sha256: campaign.cpu_moe_comparison_sha256,
    units: {
      "sweep.short": {
        status: "complete",
        artifacts: shortArtifacts,
      },
    },
  });

  const warm = { value: { cases: qualityCases() }, telemetry: {} };
  const sustained = { value: { cases: sustainedCases() }, telemetry: {} };
  const cold = Array.from({ length: 3 }, () => ({
    value: {
      cases: [{
        case_id: "C-01",
        load_duration_ms: 1_000,
        round: {
          request_start_ns: 1,
          request_sent_ns: 2,
          first_sse_event_ns: 3,
          first_output_ns: 4,
          response_end_ns: 5,
          ttft_ms: 0.000003,
          post_upload_ttft_ms: 0.000002,
          total_wall_ms: 0.000004,
          timings: {
            cache_n: 0,
            prompt_n: 128,
            prompt_ms: 1_000,
            predicted_n: 64,
            predicted_ms: 16_000,
          },
          usage: {},
        },
      }],
    },
    telemetry: {},
  }));
  const final = {
    value: [
      benchWorkload("pp8k"),
      benchWorkload("tg1024-d8k"),
      benchWorkload("pp16k"),
      benchWorkload("tg1024-d16k"),
    ],
    telemetry: {},
  };
  const summaries = { final, warm, sustained, cold };
  await writeUnitFiles(candidateRoot, summaries);
  const derived = deriveCandidateGateFromSummaries({
    finalSummary: final,
    warmSummary: warm,
    coldSummaries: cold,
    sustainedSummary: sustained,
  });
  assert.equal(derived.quality.passed, quality);
  assert.equal(derived.gate.sustained_median_decode_ts, sustainedMedian);
  assert.equal(derived.gate.decision, decision);

  const rawFiles = (await regularFiles(candidateRoot))
    .filter(({ relative }) =>
      !["result.json", "final-campaign-state.json"].includes(relative));
  const rawSha256 = Object.fromEntries(
    await Promise.all(rawFiles.map(async ({ relative, absolute }) => [
      relative,
      await sha256File(absolute),
    ])),
  );
  const result = {
    schema_version: "ornith-bench-1",
    campaign_id: "campaign",
    candidate_id: candidateId,
    status: "complete",
    identity: {
      llama_tag: "b10099",
      llama_commit: "a".repeat(40),
      build_number: 10099,
      bench_sha256: "a".repeat(64),
      server_sha256: "b".repeat(64),
      model_sha256: "c".repeat(64),
      suite_sha256: "d".repeat(64),
      host_id: "host",
    },
    config: {
      ...candidate,
      use_mmap: true,
      use_direct_io: false,
    },
    llama_bench: {
      final: {
        ...Object.fromEntries(final.value.map(({ id, samples_ts, samples_ns, summary }) => [
          id,
          { samples_ts, samples_ns, ...summary },
        ])),
      },
    },
    server: {
      cold: cold.map(({ value }) => value.cases[0]),
      warm: { cases: warm.value.cases },
      sustained: { cases: sustained.value.cases },
      sustained_scoring_samples: derived.sustainedScoringSamples,
    },
    quality: derived.quality,
    telemetry_summary: {
      final: {},
      cold: [{}, {}, {}],
      warm: {},
      sustained: {},
    },
    gate: derived.gate,
    raw_sha256: rawSha256,
  };
  const resultPath = path.join(candidateRoot, "result.json");
  await writeJson(resultPath, result);

  const units = {};
  for (const [unitId, segments] of Object.entries(UNIT_DIRECTORIES)) {
    const directory = path.join(candidateRoot, ...segments);
    const files = (await regularFiles(directory)).map(({ absolute }) => absolute);
    if (unitId === "sustained") files.push(resultPath);
    units[unitId] = {
      status: "complete",
      artifacts: await artifactEvidence(files),
      append_stream_artifacts: await artifactEvidence([
        path.join(candidateRoot, "rounds.csv"),
        path.join(candidateRoot, "telemetry.csv"),
      ]),
    };
  }
  const finalStatePath = path.join(candidateRoot, "final-campaign-state.json");
  await writeJson(finalStatePath, {
    schema_version: "ornith-final-campaign-state-2",
    identity_sha256: "f".repeat(64),
    units,
  });
  return { candidateRoot, resultPath, finalStatePath };
}

test("campaign decision is written only from every declared hash-verified result and state", async () => {
  const root = await tempRoot("ornith-decision-");
  const campaign = await ensureCampaignFiles(root, ["one", "two"]);
  await writeCandidate(root, campaign, "one", {
    decision: "INTEGRATE",
    quality: 17,
    sustainedMedian: 4,
  });
  await writeCandidate(root, campaign, "two", {
    decision: "INTEGRATE",
    quality: 17,
    sustainedMedian: 4,
  });
  const output = await writeCampaignDecision({
    resultRoot: root,
    campaignId: "campaign",
    candidateIds: ["one", "two"],
  });
  assert.equal(output.selected_candidate_id, "one");
  const decision = JSON.parse(await readFile(output.decision_path, "utf8"));
  assert.equal(decision.schema_version, "ornith-campaign-decision-1");
  for (const candidateId of ["one", "two"]) {
    assert.match(
      decision.raw_sha256[
        `candidates/${candidateId}/final-campaign-state.json`
      ],
      /^[a-f0-9]{64}$/,
    );
    assert.match(
      decision.raw_sha256[`candidates/${candidateId}/result.json`],
      /^[a-f0-9]{64}$/,
    );
  }
  await assert.rejects(
    writeCampaignDecision({
      resultRoot: root,
      campaignId: "campaign",
      candidateIds: ["one", "two"],
    }),
    /EEXIST/,
  );
});

test("campaign decision recomputes gates even when a tampered result is re-bound to final state", async () => {
  const root = await tempRoot("ornith-decision-gate-");
  const campaign = await ensureCampaignFiles(root, ["one"]);
  const written = await writeCandidate(root, campaign, "one", {
    decision: "INTEGRATE",
    quality: 17,
    sustainedMedian: 4,
  });
  const result = JSON.parse(await readFile(written.resultPath, "utf8"));
  result.gate.decision = "STRONG_INTEGRATE";
  await writeJson(written.resultPath, result);
  const state = JSON.parse(await readFile(written.finalStatePath, "utf8"));
  const resultArtifact = state.units.sustained.artifacts.find(
    ({ path: artifactPath }) => artifactPath === written.resultPath,
  );
  resultArtifact.sha256 = await sha256File(written.resultPath);
  await writeJson(written.finalStatePath, state);

  await assert.rejects(
    writeCampaignDecision({
      resultRoot: root,
      campaignId: "campaign",
      candidateIds: ["one"],
    }),
    /CAMPAIGN_DECISION_RECOMPUTED_GATE_MISMATCH/,
  );
});

test("campaign decision rejects a missing result or damaged raw closure", async () => {
  const root = await tempRoot("ornith-decision-bad-");
  const campaign = await ensureCampaignFiles(root, ["one", "missing"]);
  const written = await writeCandidate(root, campaign, "one", {
    decision: "INTEGRATE",
    quality: 17,
    sustainedMedian: 4,
  });
  await assert.rejects(
    writeCampaignDecision({
      resultRoot: root,
      campaignId: "campaign",
      candidateIds: ["one", "missing"],
    }),
    /ENOENT/,
  );
  await writeFile(path.join(written.candidateRoot, "rounds.csv"), "changed");
  await assert.rejects(
    writeCampaignDecision({
      resultRoot: root,
      campaignId: "campaign",
      candidateIds: ["one"],
    }),
    /CAMPAIGN_DECISION_RESULT_RAW_HASH_MISMATCH/,
  );
});
