import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFinalCampaign } from "../src/final-campaign.mjs";
import { tempRoot } from "./temp-root.mjs";

const TEST_POLICIES = Object.freeze({
  "final-bench": { required: ["result.json"], dynamic: [] },
  "cold-1": { required: ["result.json"], dynamic: [] },
  "cold-2": { required: ["result.json"], dynamic: [] },
  "cold-3": { required: ["result.json"], dynamic: [] },
  "warm-quality": { required: ["result.json"], dynamic: [] },
  sustained: { required: ["result.json"], dynamic: [] },
});

function evidence() {
  return {
    identity: { runtime: "pinned" },
    harnessSourceSha256: "a".repeat(64),
    armComparisonManifestSha256: "b".repeat(64),
    unitPolicies: TEST_POLICIES,
  };
}

test("final campaign runs each bounded unit once and resumes hash-verified output", async () => {
  const root = await tempRoot("ornith-final-campaign-");
  const calls = [];
  const config = {
    campaign_id: "campaign",
    candidate_id: "cache-on",
    result_root: root,
    live: { moe_cache_mode: "on" },
  };
  const runtime = {
    runUnit: async ({ unitId, artifactDirectory }) => {
      calls.push(unitId);
      const artifact = path.join(artifactDirectory, "result.json");
      await writeFile(artifact, JSON.stringify({ unitId }), { flag: "wx" });
      return { artifacts: [artifact], result: { unit_id: unitId } };
    },
  };

  const first = await runFinalCampaign({
    config,
    ...evidence(),
    cwd: root,
    runtime,
  });
  assert.deepEqual(calls, [
    "final-bench",
    "cold-1",
    "cold-2",
    "cold-3",
    "warm-quality",
    "sustained",
  ]);
  assert.equal(first.completed.length, 6);

  const resumed = await runFinalCampaign({
    config,
    ...evidence(),
    cwd: root,
    runtime,
  });
  assert.equal(calls.length, 6);
  assert.equal(resumed.resumed.length, 6);
});

test("final campaign requires explicit cache mode and never retries a failed unit", async () => {
  const root = await tempRoot("ornith-final-fail-");
  let calls = 0;
  await assert.rejects(
    runFinalCampaign({
      config: {
        campaign_id: "campaign",
        candidate_id: "cache-default",
        result_root: root,
        live: {},
      },
      ...evidence(),
      cwd: root,
      runtime: { runUnit: async () => assert.fail("must not run") },
    }),
    /FINAL_CAMPAIGN_REQUIRES_EXPLICIT_MOE_CACHE_MODE/,
  );
  await assert.rejects(
    runFinalCampaign({
      config: {
        campaign_id: "campaign",
        candidate_id: "cache-off",
        result_root: root,
        live: { moe_cache_mode: "off" },
      },
      ...evidence(),
      cwd: root,
      runtime: {
        runUnit: async () => {
          calls += 1;
          throw new Error("synthetic failure");
        },
      },
    }),
    /synthetic failure/,
  );
  assert.equal(calls, 1);
});

test("resume identity binds full config, harness source, arm manifest, and artifact policy", async () => {
  for (const mutation of [
    (input) => { input.config.candidate = { threads: 19 }; },
    (input) => { input.harnessSourceSha256 = "c".repeat(64); },
    (input) => { input.armComparisonManifestSha256 = "d".repeat(64); },
    (input) => { input.unitPolicies.sustained.required.push("extra.json"); },
  ]) {
    const root = await tempRoot("ornith-final-identity-");
    const config = {
      campaign_id: "campaign",
      candidate_id: "cache-on",
      result_root: root,
      live: { moe_cache_mode: "on" },
      candidate: { threads: 20 },
    };
    const runtime = {
      runUnit: async ({ unitId, artifactDirectory }) => {
        const artifact = path.join(artifactDirectory, "result.json");
        await writeFile(artifact, JSON.stringify({ unitId }), { flag: "wx" });
        return { artifacts: [artifact] };
      },
    };
    await runFinalCampaign({ config, ...evidence(), cwd: root, runtime });
    const changed = {
      config: structuredClone(config),
      ...evidence(),
      unitPolicies: structuredClone(TEST_POLICIES),
    };
    mutation(changed);
    await assert.rejects(
      runFinalCampaign({ ...changed, cwd: root, runtime }),
      /FINAL_CAMPAIGN_RESUME_IDENTITY_MISMATCH/,
    );
  }
});

test("unit completion requires its exact nonempty artifact set and rejects hidden files", async () => {
  const root = await tempRoot("ornith-final-policy-");
  const config = {
    campaign_id: "campaign",
    candidate_id: "cache-on",
    result_root: root,
    live: { moe_cache_mode: "on" },
  };
  await assert.rejects(
    runFinalCampaign({
      config,
      ...evidence(),
      cwd: root,
      runtime: {
        runUnit: async ({ artifactDirectory }) => {
          const artifact = path.join(artifactDirectory, "result.json");
          await writeFile(artifact, "{}");
          await writeFile(path.join(artifactDirectory, "hidden.txt"), "not recorded");
          return { artifacts: [artifact] };
        },
      },
    }),
    /FINAL_CAMPAIGN_ARTIFACT_CLOSURE_MISMATCH/,
  );
  await assert.rejects(
    runFinalCampaign({
      config: { ...config, candidate_id: "cache-on-missing" },
      ...evidence(),
      cwd: root,
      runtime: {
        runUnit: async () => ({ artifacts: [] }),
      },
    }),
    /FINAL_CAMPAIGN_UNIT_ARTIFACTS_MISSING/,
  );
});

test("resume binds the latest rounds and telemetry append streams", async () => {
  for (const mutate of [
    async (candidateRoot) => {
      const rounds = path.join(candidateRoot, "rounds.csv");
      await writeFile(rounds, `${await readFile(rounds, "utf8")}tamper\n`);
    },
    async (candidateRoot) => {
      await rm(path.join(candidateRoot, "telemetry.csv"));
    },
  ]) {
    const root = await tempRoot("ornith-final-streams-");
    const config = {
      campaign_id: "campaign",
      candidate_id: "cache-on",
      result_root: root,
      live: { moe_cache_mode: "on" },
    };
    const runtime = {
      runUnit: async ({ unitId, artifactDirectory }) => {
        const artifact = path.join(artifactDirectory, "result.json");
        await writeFile(artifact, JSON.stringify({ unitId }), { flag: "wx" });
        return { artifacts: [artifact] };
      },
    };
    await runFinalCampaign({
      config,
      ...evidence(),
      cwd: root,
      runtime,
    });
    const candidateRoot = path.join(root, "candidates", "cache-on");
    await mutate(candidateRoot);
    await assert.rejects(
      runFinalCampaign({
        config,
        ...evidence(),
        cwd: root,
        runtime,
      }),
      /FINAL_STATE_ARTIFACT_HASH_MISMATCH|CANDIDATE_APPEND_STREAM_SET_INCOMPLETE/,
    );
  }
});
