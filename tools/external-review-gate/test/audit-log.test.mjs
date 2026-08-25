import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../src/audit-log.mjs";

function event(reasonCode) {
  return {
    eventType: "review",
    outcome: "allowed",
    requestSha256: "1".repeat(64),
    commandSha256: "2".repeat(64),
    cwdSha256: "3".repeat(64),
    providerId: "synthetic",
    riskLevel: "low",
    authLevel: "medium",
    reasonCode,
  };
}

test("audit HMAC and previous-record chain verify intact records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
  const audit = new AuditLog({ directory, key: Buffer.alloc(32, 5) });
  await audit.append(event("FIRST_EVENT"));
  await audit.append(event("SECOND_EVENT"));
  const verified = await audit.verify();
  assert.equal(verified.records, 2);
  assert.match(verified.headSha256, /^[0-9a-f]{64}$/);
});

test("audit verification rejects record tampering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
  const audit = new AuditLog({ directory, key: Buffer.alloc(32, 5) });
  await audit.append(event("FIRST_EVENT"));
  await audit.append(event("SECOND_EVENT"));
  const [first] = await audit.listRecordPaths();
  const record = JSON.parse(await readFile(first, "utf8"));
  record.reasonCode = "TAMPERED_EVENT";
  await writeFile(first, JSON.stringify(record), "utf8");
  await assert.rejects(audit.verify(), /HMAC|chain/i);
});

test("audit resumes its authenticated sequence after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
  const key = Buffer.alloc(32, 5);
  const firstRuntime = new AuditLog({ directory, key });
  await firstRuntime.append(event("FIRST_EVENT"));

  const restartedRuntime = new AuditLog({ directory, key });
  await restartedRuntime.append(event("SECOND_EVENT"));
  const verified = await restartedRuntime.verify();
  assert.equal(verified.records, 2);
});

test("audit verification rejects tail and all-record deletion", async (t) => {
  await t.test("tail deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
    const audit = new AuditLog({ directory, key: Buffer.alloc(32, 5) });
    await audit.append(event("FIRST_EVENT"));
    await audit.append(event("SECOND_EVENT"));
    const records = await audit.listRecordPaths();
    await unlink(records.at(-1));
    await assert.rejects(audit.verify(), /head|sequence|truncat/i);
  });

  await t.test("all-record deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
    const audit = new AuditLog({ directory, key: Buffer.alloc(32, 5) });
    await audit.append(event("ONLY_EVENT"));
    for (const recordPath of await audit.listRecordPaths()) {
      await unlink(recordPath);
    }
    await assert.rejects(audit.verify(), /head|sequence|truncat/i);
  });
});

test("audit verification rejects authenticated-head tampering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
  const audit = new AuditLog({ directory, key: Buffer.alloc(32, 5) });
  await audit.append(event("FIRST_EVENT"));
  const headPath = path.join(directory, "audit-head.json");
  const head = JSON.parse(await readFile(headPath, "utf8"));
  head.sequence += 1;
  await writeFile(headPath, JSON.stringify(head), "utf8");
  await assert.rejects(audit.verify(), /head HMAC/i);
});

test("concurrent AuditLog instances cannot corrupt the chain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-review-audit-"));
  const key = Buffer.alloc(32, 5);
  const first = new AuditLog({ directory, key });
  const second = new AuditLog({ directory, key });
  const results = await Promise.allSettled([
    first.append(event("FIRST_EVENT")),
    second.append(event("SECOND_EVENT")),
  ]);
  const completed = results.filter((result) => result.status === "fulfilled").length;
  const verified = await new AuditLog({ directory, key }).verify();
  assert.equal(verified.records, completed);
  assert.ok(completed >= 1);
});
