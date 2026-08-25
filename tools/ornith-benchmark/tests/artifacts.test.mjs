import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempRoot } from "./temp-root.mjs";

import {
  ROUNDS_CSV_HEADER,
  appendRoundRecords,
  appendRawArtifact,
  createCampaignLayout,
  writeDerivedJson,
} from "../src/artifacts.mjs";

test("campaign layout matches the protocol and raw captures are immutable", async () => {
  const root = await tempRoot("ornith-artifacts-");
  const layout = await createCampaignLayout(root, "candidate-01");

  assert.deepEqual(layout.relativePaths, [
    "campaign.json",
    "inventory/versions.txt",
    "inventory/hashes.sha256",
    "inventory/devices.txt",
    "inventory/gpu-topology.txt",
    "inventory/host.txt",
    "candidates/candidate-01/config.json",
    "candidates/candidate-01/sweep/pp2k.raw.json",
    "candidates/candidate-01/sweep/tg256-d2k.raw.json",
    "candidates/candidate-01/final/pp8k.raw.json",
    "candidates/candidate-01/final/tg1024-d8k.raw.json",
    "candidates/candidate-01/final/pp16k.raw.json",
    "candidates/candidate-01/final/tg1024-d16k.raw.json",
    "candidates/candidate-01/server/cold",
    "candidates/candidate-01/server/warm",
    "candidates/candidate-01/server/sustained",
    "candidates/candidate-01/rounds.csv",
    "candidates/candidate-01/telemetry.csv",
    "candidates/candidate-01/result.json",
    "decision.json",
  ]);

  const raw = path.join(
    root,
    "candidates",
    "candidate-01",
    "sweep",
    "pp2k.raw.json",
  );
  await appendRawArtifact(raw, Buffer.from('{"samples_ts":[1]}'));
  await assert.rejects(
    appendRawArtifact(raw, Buffer.from('{"samples_ts":[2]}')),
    /RAW_ARTIFACT_EXISTS/,
  );
});

test("derived JSON records the hash of every raw input", async () => {
  const root = await tempRoot("ornith-derived-");
  const raw = path.join(root, "sample.raw.json");
  const derived = path.join(root, "result.json");
  await appendRawArtifact(raw, Buffer.from('{"value":1}'));

  await writeDerivedJson(derived, { status: "complete" }, [raw]);
  const parsed = JSON.parse(await readFile(derived, "utf8"));
  assert.equal(parsed.status, "complete");
  assert.match(parsed.raw_sha256["sample.raw.json"], /^[a-f0-9]{64}$/);
});

test("round CSV receives actual model rounds and derived hashes reject key collisions", async () => {
  const root = await tempRoot("ornith-rounds-");
  const rounds = path.join(root, "rounds.csv");
  await writeFile(rounds, `${ROUNDS_CSV_HEADER}\n`);
  await appendRoundRecords(rounds, [{
    schema_version: "ornith-bench-1",
    case_id: "E-01",
    round_index: 0,
    decode_tok_s: 3.25,
    outcome: "pass",
  }]);
  const text = await readFile(rounds, "utf8");
  assert.match(text, /\nornith-bench-1,[^\n]*E-01,0,/);
  const a = path.join(root, "a", "raw.json");
  const b = path.join(root, "b", "raw.json");
  await mkdir(path.dirname(a), { recursive: true });
  await mkdir(path.dirname(b), { recursive: true });
  await writeFile(a, "a");
  await writeFile(b, "b");
  await assert.rejects(
    writeDerivedJson(path.join(root, "collision.json"), {}, [a, b]),
    /DERIVED_RAW_KEY_COLLISION/,
  );
  await writeDerivedJson(
    path.join(root, "bound.json"),
    {},
    [a, b],
    { keyRoot: root },
  );
  const bound = JSON.parse(
    await readFile(path.join(root, "bound.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(bound.raw_sha256), [
    "a/raw.json",
    "b/raw.json",
  ]);
});

test("round appends reject missing or damaged headers instead of recreating a corrupt stream", async () => {
  const root = await tempRoot("ornith-round-header-");
  const missing = path.join(root, "missing.csv");
  await assert.rejects(
    appendRoundRecords(missing, [{
      schema_version: "ornith-bench-1",
      case_id: "E-01",
      round_index: 0,
    }]),
    /ENOENT/,
  );
  await assert.rejects(access(missing), /ENOENT/);

  const damaged = path.join(root, "damaged.csv");
  await writeFile(damaged, "not-the-protocol-header\n");
  await assert.rejects(
    appendRoundRecords(damaged, [{
      schema_version: "ornith-bench-1",
      case_id: "E-01",
      round_index: 0,
    }]),
    /APPEND_CSV_HEADER_INVALID/,
  );
  assert.equal(await readFile(damaged, "utf8"), "not-the-protocol-header\n");
});
