import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempRoot } from "./temp-root.mjs";

import {
  createCampaignState,
  loadCampaignState,
  markUnitComplete,
} from "../src/campaign-state.mjs";

test("campaign state resumes only hash-verified completed atomic units", async () => {
  const root = await tempRoot("ornith-state-");
  const artifact = path.join(root, "pp2k.raw.json");
  const telemetryStderr = path.join(root, "nvidia-query.stderr.txt");
  await writeFile(artifact, "[]");
  await writeFile(telemetryStderr, "");
  const statePath = path.join(root, "campaign-state.json");
  const artifactPolicy = {
    resultRoot: root,
    candidateRoot: root,
    allowed: [
      { path: artifact, maxBytes: 1024 },
      { path: telemetryStderr, maxBytes: 1024 },
    ],
  };
  let state = createCampaignState({
    campaignId: "c",
    candidateId: "x",
    configSha256: "a".repeat(64),
    identitySha256: "b".repeat(64),
    artifactPolicy,
  });
  state = await markUnitComplete(statePath, state, "sweep.pp2k", [
    artifact,
    telemetryStderr,
  ], artifactPolicy);
  const loaded = await loadCampaignState(statePath, {
    campaignId: "c",
    candidateId: "x",
    configSha256: "a".repeat(64),
    identitySha256: "b".repeat(64),
    artifactPolicy,
  });
  assert.equal(loaded.units["sweep.pp2k"].status, "complete");
  await writeFile(telemetryStderr, "tampered");
  await assert.rejects(
    loadCampaignState(statePath, {
      campaignId: "c",
      candidateId: "x",
      configSha256: "a".repeat(64),
      identitySha256: "b".repeat(64),
      artifactPolicy,
    }),
    /RESUME_ARTIFACT_HASH_MISMATCH/,
  );
  assert.match(await readFile(statePath, "utf8"), /sweep\.pp2k/);
});

test("resume rejects an untrusted artifact path before hashing it", async () => {
  const root = await tempRoot("ornith-state-path-");
  const allowed = path.join(root, "allowed.json");
  await writeFile(allowed, "{}");
  const statePath = path.join(root, "campaign-state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      schema_version: "ornith-campaign-state-1",
      campaign_id: "c",
      candidate_id: "x",
      config_sha256: "a".repeat(64),
      identity_sha256: "b".repeat(64),
      units: {
        "sweep.short": {
          status: "complete",
          artifacts: [{
            path: path.join(path.parse(root).root, "not-allowlisted-model.gguf"),
            sha256: "c".repeat(64),
          }],
        },
      },
    }),
  );
  await assert.rejects(
    loadCampaignState(statePath, {
      campaignId: "c",
      candidateId: "x",
      configSha256: "a".repeat(64),
      identitySha256: "b".repeat(64),
      artifactPolicy: {
        resultRoot: root,
        candidateRoot: root,
        allowed: [{ path: allowed, maxBytes: 1024 }],
      },
    }),
    /STATE_ARTIFACT_NOT_ALLOWLISTED/,
  );
});

test("artifact policy rejects directories and oversized regular files before hashing", async () => {
  const root = await tempRoot("ornith-state-shape-");
  const statePath = path.join(root, "campaign-state.json");
  const artifactPath = path.join(root, "allowed.json");
  const expected = {
    campaignId: "c",
    candidateId: "x",
    configSha256: "a".repeat(64),
    identitySha256: "b".repeat(64),
    artifactPolicy: {
      resultRoot: root,
      candidateRoot: root,
      allowed: [{ path: artifactPath, maxBytes: 1 }],
    },
  };
  const writeState = () =>
    writeFile(
      statePath,
      JSON.stringify({
        schema_version: "ornith-campaign-state-1",
        campaign_id: "c",
        candidate_id: "x",
        config_sha256: "a".repeat(64),
        identity_sha256: "b".repeat(64),
        units: {
          "sweep.short": {
            status: "complete",
            artifacts: [{
              path: artifactPath,
              sha256: "c".repeat(64),
            }],
          },
        },
      }),
    );

  await mkdir(artifactPath);
  await writeState();
  await assert.rejects(
    loadCampaignState(statePath, expected),
    /STATE_ARTIFACT_TYPE_OR_SIZE_INVALID/,
  );

  await rmdir(artifactPath);
  await writeFile(artifactPath, "too large");
  await writeState();
  await assert.rejects(
    loadCampaignState(statePath, expected),
    /STATE_ARTIFACT_TYPE_OR_SIZE_INVALID/,
  );
});

test("artifact policy rejects in-root reparse traversal before hashing", async () => {
  const root = await tempRoot("ornith-state-reparse-");
  const actualDirectory = path.join(root, "actual");
  const linkedDirectory = path.join(root, "linked");
  await mkdir(actualDirectory);
  await symlink(
    actualDirectory,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  const artifactPath = path.join(linkedDirectory, "allowed.json");
  await writeFile(path.join(actualDirectory, "allowed.json"), "{}");
  const statePath = path.join(root, "campaign-state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      schema_version: "ornith-campaign-state-1",
      campaign_id: "c",
      candidate_id: "x",
      config_sha256: "a".repeat(64),
      identity_sha256: "b".repeat(64),
      units: {
        "sweep.short": {
          status: "complete",
          artifacts: [{
            path: artifactPath,
            sha256: "c".repeat(64),
          }],
        },
      },
    }),
  );
  await assert.rejects(
    loadCampaignState(statePath, {
      campaignId: "c",
      candidateId: "x",
      configSha256: "a".repeat(64),
      identitySha256: "b".repeat(64),
      artifactPolicy: {
        resultRoot: root,
        candidateRoot: root,
        allowed: [{ path: artifactPath, maxBytes: 1024 }],
      },
    }),
    /STATE_ARTIFACT_REPARSE_FORBIDDEN/,
  );
});
