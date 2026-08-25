import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalStore } from "../src/approval-store.mjs";
import { AuditLog } from "../src/audit-log.mjs";
import { InactiveBrokerAdapter } from "../src/broker-adapter.mjs";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-adapter-"));
  const projectRoot = path.join(base, "project");
  const stateRoot = path.join(base, "state");
  await mkdir(projectRoot);
  await mkdir(stateRoot);
  const request = {
    version: 1,
    executable: process.execPath,
    argv: ["--version"],
    cwd: projectRoot,
    timeoutMs: 1_000,
    authLevel: "medium",
    requestNonce: "a".repeat(32),
  };
  let reviewerCalls = 0;
  const reviewer = {
    providerId: "synthetic-reviewer",
    async review({ requestNonce }) {
      reviewerCalls += 1;
      assert.equal(requestNonce, request.requestNonce);
      return {
        decision: "allow",
        riskLevel: "low",
        authLevel: "medium",
        reasonCode: "SCOPED_ACTION",
      };
    },
  };
  const store = new ApprovalStore({
    directory: path.join(stateRoot, "approvals"),
    key: Buffer.alloc(32, 1),
    bootNonce: Buffer.alloc(32, 2),
  });
  const audit = new AuditLog({
    directory: path.join(stateRoot, "audit"),
    key: Buffer.alloc(32, 3),
  });
  let executions = 0;
  const adapter = new InactiveBrokerAdapter({
    projectRoot,
    reviewer,
    store,
    audit,
    executor: async () => {
      executions += 1;
      return { exitCode: 0, timedOut: false };
    },
  });
  return {
    adapter,
    request,
    reviewerCalls: () => reviewerCalls,
    executions: () => executions,
  };
}

test("broker adapter performs review and execution without exposing an approval handle", async () => {
  const f = await fixture();
  const result = await f.adapter.run(f.request);
  assert.deepEqual(result, { exitCode: 0, timedOut: false });
  assert.equal(Object.hasOwn(result, "approvalId"), false);
  assert.equal(f.reviewerCalls(), 1);
  assert.equal(f.executions(), 1);
});

test("broker adapter rejects missing, extra, and model-supplied approval fields", async (t) => {
  await t.test("missing request nonce", async () => {
    const f = await fixture();
    const { requestNonce: _requestNonce, ...missing } = f.request;
    await assert.rejects(f.adapter.run(missing), /wrong fields/i);
    assert.equal(f.reviewerCalls(), 0);
    assert.equal(f.executions(), 0);
  });

  await t.test("generic extra field", async () => {
    const f = await fixture();
    await assert.rejects(
      f.adapter.run({ ...f.request, unexpected: true }),
      /wrong fields/i,
    );
    assert.equal(f.reviewerCalls(), 0);
    assert.equal(f.executions(), 0);
  });

  await t.test("model-supplied approval id", async () => {
    const f = await fixture();
    await assert.rejects(
      f.adapter.run({ ...f.request, approvalId: "0".repeat(32) }),
      /approval identifiers are broker-private/i,
    );
    assert.equal(f.reviewerCalls(), 0);
    assert.equal(f.executions(), 0);
  });
});
