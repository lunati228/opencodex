import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  harnessImplementationDigest,
  validateControlledArmManifest,
} from "../src/final-evidence.mjs";
import { shortSweepArtifactPolicy } from "../src/campaign-state.mjs";
import { canonicalJson, sha256Bytes, sha256File } from "../src/hash.mjs";
import { tempRoot } from "./temp-root.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return { path: filePath, sha256: await sha256File(filePath) };
}

async function rewriteEvidence(evidence, value) {
  await writeFile(evidence.path, `${JSON.stringify(value, null, 2)}\n`);
  evidence.sha256 = await sha256File(evidence.path);
}

async function fixture() {
  const root = await tempRoot("ornith-arm-evidence-");
  const candidate = { threads: 20, n_cpu_moe: 60 };
  const campaignIdentity = { runtime: "pinned" };
  const comparisonSha256 = "d".repeat(64);
  const campaign = await writeJson(path.join(root, "campaign.json"), {
    schema_version: "ornith-campaign-1",
    campaign_id: "campaign",
    identity: campaignIdentity,
    cpu_moe_sweep: {
      values: [60],
      candidate_ids: ["finalist"],
    },
    cpu_moe_comparison_sha256: comparisonSha256,
  });
  const candidateRoot = path.join(root, "candidates", "finalist");
  const configPath = path.join(candidateRoot, "config.json");
  const config = {
    campaign_id: "campaign",
    candidate_id: "finalist",
    result_root: root,
    live: {
      moe_cache_mode: "on",
      cpu_moe_sweep: {
        values: [60],
        candidate_ids: ["finalist"],
        index: 0,
      },
    },
    candidate,
  };
  const configEvidence = await writeJson(configPath, config);
  const artifactPolicy = shortSweepArtifactPolicy(root, candidateRoot);
  for (const rule of artifactPolicy.allowed) {
    if (rule.path === campaign.path || rule.path === configEvidence.path) continue;
    await mkdir(path.dirname(rule.path), { recursive: true });
    await writeFile(
      rule.path,
      `fixture:${path.relative(root, rule.path)}\n`,
    );
  }
  const artifacts = await Promise.all(
    artifactPolicy.allowed.map(async ({ path: artifactPath }) => ({
      path: artifactPath,
      sha256: await sha256File(artifactPath),
    })),
  );
  const state = await writeJson(path.join(candidateRoot, "campaign-state.json"), {
    schema_version: "ornith-campaign-state-1",
    campaign_id: "campaign",
    candidate_id: "finalist",
    config_sha256: sha256Bytes(canonicalJson(config)),
    identity_sha256: sha256Bytes(canonicalJson(campaignIdentity)),
    comparison_sha256: comparisonSha256,
    units: {
      "sweep.short": {
        status: "complete",
        completed_at_utc: "2026-07-26T00:00:00.000Z",
        artifacts,
      },
    },
  });
  const manifestPath = path.join(root, "controlled-arms.json");
  const comparable = {
    candidate,
    runtime_identity_sha256: "c".repeat(64),
  };
  const manifest = {
    schema_version: "ornith-controlled-arms-1",
    campaign_id: "campaign",
    finalist_candidate_id: "finalist",
    campaign,
    completed_sweep_states: [{
      candidate_id: "finalist",
      state,
      config: configEvidence,
    }],
    arms: [
      { ...structuredClone(comparable), moe_cache_mode: "off" },
      { ...structuredClone(comparable), moe_cache_mode: "on" },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    root,
    config,
    manifest,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    state,
    configEvidence,
    candidateRoot,
  };
}

test("controlled arm manifest binds a completed sweep and differs only by cache mode", async () => {
  const value = await fixture();
  const evidence = await validateControlledArmManifest({
    config: value.config,
    manifestPath: value.manifestPath,
    expectedSha256: value.manifestSha256,
    expectedRuntimeIdentitySha256: "c".repeat(64),
  });
  assert.equal(evidence.finalist_candidate_id, "finalist");
  assert.deepEqual(evidence.moe_cache_modes, ["off", "on"]);
});

test("controlled arm manifest rejects a hidden arm difference and incomplete sweep", async () => {
  for (const mutate of [
    (manifest) => { manifest.arms[1].candidate.threads = 19; },
    (manifest) => {
      manifest.arms[0].runtime_identity_sha256 = "e".repeat(64);
      manifest.arms[1].runtime_identity_sha256 = "e".repeat(64);
    },
    (manifest) => {
      manifest.completed_sweep_states[0].state.sha256 = "0".repeat(64);
    },
  ]) {
    const value = await fixture();
    mutate(value.manifest);
    await writeFile(
      value.manifestPath,
      `${JSON.stringify(value.manifest, null, 2)}\n`,
    );
    await assert.rejects(
      validateControlledArmManifest({
        config: value.config,
        manifestPath: value.manifestPath,
        expectedSha256: await sha256File(value.manifestPath),
        expectedRuntimeIdentitySha256: "c".repeat(64),
      }),
      /CONTROLLED_ARM_|COMPLETED_SWEEP_/,
    );
  }
});

test("controlled arm manifest rejects a state/config splice from a different candidate shape", async () => {
  const value = await fixture();
  const recordedConfig = JSON.parse(
    await readFile(value.configEvidence.path, "utf8"),
  );
  recordedConfig.candidate.threads = 19;
  await rewriteEvidence(value.configEvidence, recordedConfig);

  const recordedState = JSON.parse(await readFile(value.state.path, "utf8"));
  recordedState.config_sha256 = sha256Bytes(canonicalJson(recordedConfig));
  const configArtifact = recordedState.units["sweep.short"].artifacts.find(
    ({ path: artifactPath }) => artifactPath === value.configEvidence.path,
  );
  configArtifact.sha256 = value.configEvidence.sha256;
  await rewriteEvidence(value.state, recordedState);
  await writeFile(
    value.manifestPath,
    `${JSON.stringify(value.manifest, null, 2)}\n`,
  );

  await assert.rejects(
    validateControlledArmManifest({
      config: value.config,
      manifestPath: value.manifestPath,
      expectedSha256: await sha256File(value.manifestPath),
      expectedRuntimeIdentitySha256: "c".repeat(64),
    }),
    /COMPLETED_SWEEP_INVALID/,
  );
});

test("controlled arm manifest binds each state config digest to its recorded config", async () => {
  const value = await fixture();
  const state = JSON.parse(await readFile(value.state.path, "utf8"));
  state.config_sha256 = "f".repeat(64);
  await rewriteEvidence(value.state, state);
  await writeFile(
    value.manifestPath,
    `${JSON.stringify(value.manifest, null, 2)}\n`,
  );

  await assert.rejects(
    validateControlledArmManifest({
      config: value.config,
      manifestPath: value.manifestPath,
      expectedSha256: await sha256File(value.manifestPath),
      expectedRuntimeIdentitySha256: "c".repeat(64),
    }),
    /COMPLETED_SWEEP_INVALID/,
  );
});

test("controlled arm manifest requires canonical state/config paths and the full short-sweep artifact set", async () => {
  for (const mutate of [
    async (value) => {
      const displaced = path.join(value.root, "displaced-state.json");
      await writeFile(displaced, await readFile(value.state.path));
      value.manifest.completed_sweep_states[0].state = {
        path: displaced,
        sha256: await sha256File(displaced),
      };
    },
    async (value) => {
      const state = JSON.parse(await readFile(value.state.path, "utf8"));
      state.units["sweep.short"].artifacts.pop();
      await rewriteEvidence(value.state, state);
    },
  ]) {
    const value = await fixture();
    await mutate(value);
    await writeFile(
      value.manifestPath,
      `${JSON.stringify(value.manifest, null, 2)}\n`,
    );
    await assert.rejects(
      validateControlledArmManifest({
        config: value.config,
        manifestPath: value.manifestPath,
        expectedSha256: await sha256File(value.manifestPath),
        expectedRuntimeIdentitySha256: "c".repeat(64),
      }),
      /COMPLETED_SWEEP_|INVALID_CAMPAIGN_STATE_PATH|INVALID_ARTIFACT_POLICY/,
    );
  }
});

test("harness implementation digest changes when any bound source changes", async () => {
  const root = await tempRoot("ornith-source-digest-");
  const one = path.join(root, "one.mjs");
  const two = path.join(root, "two.mjs");
  await writeFile(one, "one");
  await writeFile(two, "two");
  const before = await harnessImplementationDigest([one, two]);
  await writeFile(two, "changed");
  const after = await harnessImplementationDigest([one, two]);
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.notEqual(before, after);
});
