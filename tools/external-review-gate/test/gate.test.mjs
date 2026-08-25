import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalStore } from "../src/approval-store.mjs";
import { AuditLog } from "../src/audit-log.mjs";
import { executeReviewed, reviewAndIssue } from "../src/gate.mjs";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "external-review-gate-"));
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
    requestNonce: "1".repeat(32),
  };
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  const store = new ApprovalStore({
    directory: path.join(stateRoot, "approvals"),
    key: Buffer.alloc(32, 7),
    bootNonce: Buffer.alloc(32, 8),
  });
  const audit = new AuditLog({
    directory: path.join(stateRoot, "audit"),
    key: Buffer.alloc(32, 6),
  });
  return { base, projectRoot, stateRoot, request, requestBytes, store, audit };
}

const allowReviewer = {
  providerId: "synthetic-reviewer",
  async review({ requestBytes }) {
    return {
      decision: "allow",
      riskLevel: "medium",
      authLevel: "medium",
      reasonCode: requestBytes.length > 0 ? "SCOPED_ACTION" : "EMPTY",
    };
  },
};

test("the exact full request bytes reviewed are the bytes authorized for execution", async () => {
  const f = await fixture();
  let reviewed;
  const reviewer = {
    providerId: "synthetic-reviewer",
    async review(input) {
      reviewed = Buffer.from(input.requestBytes);
      return {
        decision: "allow",
        riskLevel: "low",
        authLevel: "medium",
        reasonCode: "SCOPED_ACTION",
      };
    },
  };
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer,
    store: f.store,
    audit: f.audit,
  });
  let executed;
  await executeReviewed({
    approvalId,
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    store: f.store,
    audit: f.audit,
    executor: async (request) => {
      executed = [request.executable, ...request.argv];
      return { exitCode: 0, timedOut: false };
    },
  });
  assert.deepEqual(reviewed, f.requestBytes);
  assert.deepEqual(executed, [f.request.executable, ...f.request.argv]);
});

test("a changed byte after review fails closed and never executes", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  const changed = Buffer.from(
    JSON.stringify({ ...f.request, argv: [...f.request.argv, "--changed"] }),
    "utf8",
  );
  let executions = 0;
  await assert.rejects(
    executeReviewed({
      approvalId,
      requestBytes: changed,
      projectRoot: f.projectRoot,
      store: f.store,
      audit: f.audit,
      executor: async () => {
        executions += 1;
        return { exitCode: 0, timedOut: false };
      },
    }),
    /failed closed/i,
  );
  assert.equal(executions, 0);
  const auditPaths = await f.audit.listRecordPaths();
  const records = await Promise.all(
    auditPaths.map(async (auditPath) =>
      JSON.parse(await readFile(auditPath, "utf8")),
    ),
  );
  const rejection = records.find(
    (record) =>
      record.eventType === "execution" && record.outcome === "denied",
  );
  assert.equal(rejection.errorCode, "CONSUME_REJECTED");
  assert.equal(JSON.stringify(rejection).includes("--changed"), false);
});

test("simultaneous replay permits at most one execution", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  let executions = 0;
  const attempt = () =>
    executeReviewed({
      approvalId,
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      store: f.store,
      audit: f.audit,
      executor: async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { exitCode: 0, timedOut: false };
      },
    });
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(executions, 1);
  const records = await Promise.all(
    (await f.audit.listRecordPaths()).map(async (auditPath) =>
      JSON.parse(await readFile(auditPath, "utf8")),
    ),
  );
  assert.equal(
    records.filter(
      (record) =>
        record.eventType === "execution" && record.outcome === "denied",
    ).length,
    1,
  );
});

test("pre-execution consume rejections are always hash-only audited", async (t) => {
  await t.test("invalid approval id", async () => {
    const f = await fixture();
    let executions = 0;
    await assert.rejects(
      executeReviewed({
        approvalId: "not-an-approval",
        requestBytes: f.requestBytes,
        projectRoot: f.projectRoot,
        store: f.store,
        audit: f.audit,
        executor: async () => {
          executions += 1;
          return { exitCode: 0, timedOut: false };
        },
      }),
      /failed closed/i,
    );
    assert.equal(executions, 0);
    const [auditPath] = await f.audit.listRecordPaths();
    const record = JSON.parse(await readFile(auditPath, "utf8"));
    assert.equal(record.eventType, "execution");
    assert.equal(record.outcome, "denied");
    assert.equal(record.errorCode, "CONSUME_REJECTED");
    assert.match(record.requestSha256, /^[0-9a-f]{64}$/);
    assert.equal(record.commandSha256, "");
    assert.equal(JSON.stringify(record).includes(f.request.executable), false);
  });

  await t.test("tampered approval", async () => {
    const f = await fixture();
    const approvalId = await reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store: f.store,
      audit: f.audit,
    });
    const approvalPath = path.join(
      f.stateRoot,
      "approvals",
      `${approvalId}.json`,
    );
    const record = JSON.parse(await readFile(approvalPath, "utf8"));
    record.requestNonce = "0".repeat(32);
    await writeFile(approvalPath, JSON.stringify(record), "utf8");
    await assert.rejects(
      executeReviewed({
        approvalId,
        requestBytes: f.requestBytes,
        projectRoot: f.projectRoot,
        store: f.store,
        audit: f.audit,
        executor: async () => {
          throw new Error("must not execute");
        },
      }),
      /failed closed/i,
    );
    const records = await Promise.all(
      (await f.audit.listRecordPaths()).map(async (auditPath) =>
        JSON.parse(await readFile(auditPath, "utf8")),
      ),
    );
    assert.equal(
      records.some(
        (item) =>
          item.eventType === "execution" &&
          item.outcome === "denied" &&
          item.errorCode === "CONSUME_REJECTED",
      ),
      true,
    );
  });

  await t.test("expired approval", async () => {
    const f = await fixture();
    let nowMs = 1_000;
    const store = new ApprovalStore({
      directory: path.join(f.stateRoot, "expiring-execution-approvals"),
      key: Buffer.alloc(32, 7),
      bootNonce: Buffer.alloc(32, 8),
      now: () => nowMs,
      ttlMs: 50,
    });
    const approvalId = await reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store,
      audit: f.audit,
    });
    nowMs = 1_050;
    await assert.rejects(
      executeReviewed({
        approvalId,
        requestBytes: f.requestBytes,
        projectRoot: f.projectRoot,
        store,
        audit: f.audit,
        executor: async () => {
          throw new Error("must not execute");
        },
      }),
      /failed closed/i,
    );
    const records = await Promise.all(
      (await f.audit.listRecordPaths()).map(async (auditPath) =>
        JSON.parse(await readFile(auditPath, "utf8")),
      ),
    );
    assert.equal(
      records.some(
        (item) =>
          item.eventType === "execution" &&
          item.outcome === "denied" &&
          item.errorCode === "CONSUME_REJECTED",
      ),
      true,
    );
  });
});

test("consume rejection remains fail closed when its audit write fails", async () => {
  const f = await fixture();
  let executions = 0;
  let auditAttempts = 0;
  await assert.rejects(
    executeReviewed({
      approvalId: "invalid",
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      store: f.store,
      audit: {
        async append() {
          auditAttempts += 1;
          throw new Error("synthetic audit failure");
        },
      },
      executor: async () => {
        executions += 1;
        return { exitCode: 0, timedOut: false };
      },
    }),
    /audit failed closed/i,
  );
  assert.equal(auditAttempts, 1);
  assert.equal(executions, 0);
});

test("a broker restart invalidates outstanding approvals", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  const restartedStore = new ApprovalStore({
    directory: path.join(f.stateRoot, "approvals"),
    key: Buffer.alloc(32, 7),
    bootNonce: Buffer.alloc(32, 9),
  });
  await assert.rejects(
    restartedStore.consume({
      approvalId,
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
    }),
    /runtime/i,
  );
});

test("duplicate request nonce issuance is rejected atomically", async () => {
  const f = await fixture();
  const issue = () =>
    reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store: f.store,
      audit: f.audit,
    });
  const results = await Promise.allSettled([issue(), issue()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.cause?.message ?? "", /already issued/i);
  const issued = results.find((result) => result.status === "fulfilled").value;
  await executeReviewed({
    approvalId: issued,
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    store: f.store,
    audit: f.audit,
    executor: async () => ({ exitCode: 0, timedOut: false }),
  });
  await assert.rejects(
    issue(),
    (error) => /already issued/i.test(error.cause?.message ?? ""),
  );
});

test("a changed caller request nonce cannot consume an approval", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  const changedNonceBytes = Buffer.from(
    JSON.stringify({ ...f.request, requestNonce: "2".repeat(32) }),
    "utf8",
  );
  await assert.rejects(
    f.store.consume({
      approvalId,
      requestBytes: changedNonceBytes,
      projectRoot: f.projectRoot,
    }),
    /reviewed bytes/i,
  );
});

test("an approval cannot be consumed under a different containing project root", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  await assert.rejects(
    f.store.consume({
      approvalId,
      requestBytes: f.requestBytes,
      projectRoot: f.base,
    }),
    /digest mismatch/i,
  );
});

test("expiry and signed request-nonce tampering fail closed", async (t) => {
  await t.test("expired", async () => {
    const f = await fixture();
    let nowMs = 1_000;
    const store = new ApprovalStore({
      directory: path.join(f.stateRoot, "expiring-approvals"),
      key: Buffer.alloc(32, 7),
      bootNonce: Buffer.alloc(32, 8),
      now: () => nowMs,
      ttlMs: 50,
    });
    const approvalId = await reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store,
      audit: f.audit,
    });
    nowMs = 1_051;
    await assert.rejects(
      store.consume({
        approvalId,
        requestBytes: f.requestBytes,
        projectRoot: f.projectRoot,
      }),
      /expired/i,
    );
  });

  await t.test("request nonce tampering in the approval record", async () => {
    const f = await fixture();
    const approvalId = await reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store: f.store,
      audit: f.audit,
    });
    const approvalPath = path.join(
      f.stateRoot,
      "approvals",
      `${approvalId}.json`,
    );
    const record = JSON.parse(await readFile(approvalPath, "utf8"));
    record.requestNonce = "0".repeat(32);
    await writeFile(approvalPath, JSON.stringify(record), "utf8");
    await assert.rejects(
      f.store.consume({
        approvalId,
        requestBytes: f.requestBytes,
        projectRoot: f.projectRoot,
      }),
      /signature/i,
    );
  });
});

test("execution never starts when the started-audit write fails", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  let executions = 0;
  await assert.rejects(
    executeReviewed({
      approvalId,
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      store: f.store,
      audit: {
        async append() {
          throw new Error("synthetic started-audit failure");
        },
      },
      executor: async () => {
        executions += 1;
        return { exitCode: 0, timedOut: false };
      },
    }),
    /started-audit failure/i,
  );
  assert.equal(executions, 0);
});

test("denial, malformed output, timeout, and insufficient authorization fail closed", async (t) => {
  const cases = [
    {
      name: "denial",
      reviewer: {
        providerId: "fake",
        review: async () => ({
          decision: "deny",
          riskLevel: "high",
          authLevel: "medium",
          reasonCode: "TOO_RISKY",
        }),
      },
    },
    {
      name: "malformed",
      reviewer: { providerId: "fake", review: async () => ({ decision: "allow" }) },
    },
    {
      name: "timeout",
      reviewer: {
        providerId: "fake",
        review: async () => new Promise(() => {}),
      },
      reviewTimeoutMs: 10,
    },
    {
      name: "insufficient authorization",
      reviewer: {
        providerId: "fake",
        review: async () => ({
          decision: "allow",
          riskLevel: "high",
          authLevel: "low",
          reasonCode: "LOW_AUTH",
        }),
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const f = await fixture();
      await assert.rejects(
        reviewAndIssue({
          requestBytes: f.requestBytes,
          projectRoot: f.projectRoot,
          reviewer: item.reviewer,
          store: f.store,
          audit: f.audit,
          reviewTimeoutMs: item.reviewTimeoutMs,
        }),
      );
    });
  }
});

test("malformed request fields fail before the reviewer is called", async () => {
  const f = await fixture();
  let calls = 0;
  const reviewer = {
    providerId: "synthetic-reviewer",
    async review() {
      calls += 1;
      return {
        decision: "allow",
        riskLevel: "low",
        authLevel: "medium",
        reasonCode: "SHOULD_NOT_RUN",
      };
    },
  };
  const malformed = Buffer.from(
    JSON.stringify({ ...f.request, unexpected: true }),
    "utf8",
  );
  await assert.rejects(
    reviewAndIssue({
      requestBytes: malformed,
      projectRoot: f.projectRoot,
      reviewer,
      store: f.store,
      audit: f.audit,
    }),
    /failed closed/i,
  );
  assert.equal(calls, 0);
  const auditPaths = await f.audit.listRecordPaths();
  assert.equal(auditPaths.length, 1);
  const auditRecord = JSON.parse(await readFile(auditPaths[0], "utf8"));
  assert.equal(auditRecord.outcome, "denied");
  assert.equal(auditRecord.errorCode, "REQUEST_INVALID");
  assert.match(auditRecord.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(auditRecord.commandSha256, "");
  assert.equal(JSON.stringify(auditRecord).includes("node --version"), false);
});

test("review timeout aborts a signal-aware provider", async () => {
  const f = await fixture();
  let aborted = false;
  const reviewer = {
    providerId: "synthetic-reviewer",
    review: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  await assert.rejects(
    reviewAndIssue({
      requestBytes: f.requestBytes,
      projectRoot: f.projectRoot,
      reviewer,
      store: f.store,
      audit: f.audit,
      reviewTimeoutMs: 10,
    }),
    /failed closed/i,
  );
  assert.equal(aborted, true);
});

test("cwd symlink escape is rejected", async (t) => {
  if (process.platform === "win32") {
    // Windows symlink creation may require Developer Mode or elevation.
    t.diagnostic("attempting Windows directory symlink; test skips only if unavailable");
  }
  const f = await fixture();
  const outside = path.join(f.base, "outside");
  const alias = path.join(f.projectRoot, "alias");
  await mkdir(outside);
  try {
    await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.code}`);
    return;
  }
  const escaped = Buffer.from(
    JSON.stringify({ ...f.request, cwd: alias }),
    "utf8",
  );
  await assert.rejects(
    reviewAndIssue({
      requestBytes: escaped,
      projectRoot: f.projectRoot,
      reviewer: allowReviewer,
      store: f.store,
      audit: f.audit,
    }),
    /failed closed/i,
  );
});

test("audit records are complete hashes and never contain command or synthetic secret", async () => {
  const f = await fixture();
  const secretMarker = "SYNTHETIC_SECRET_DO_NOT_LOG";
  const bytes = Buffer.from(
    JSON.stringify({ ...f.request, argv: ["-e", secretMarker] }),
    "utf8",
  );
  await reviewAndIssue({
    requestBytes: bytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  const files = await f.audit.listRecordPaths();
  assert.equal(files.length, 1);
  const text = await readFile(files[0], "utf8");
  const record = JSON.parse(text);
  assert.deepEqual(Object.keys(record).sort(), [
    "approvalIdHash",
    "authLevel",
    "commandSha256",
    "cwdSha256",
    "errorCode",
    "eventId",
    "eventType",
    "exitCode",
    "hmacSha256",
    "outcome",
    "previousRecordSha256",
    "providerId",
    "reasonCode",
    "requestSha256",
    "riskLevel",
    "schemaVersion",
    "sequence",
    "timestampMs",
  ]);
  assert.equal(text.includes(secretMarker), false);
  assert.equal(text.includes(f.request.executable), false);
});

test("nonzero execution exits are audited as failed with a safe exit code", async () => {
  const f = await fixture();
  const approvalId = await reviewAndIssue({
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    reviewer: allowReviewer,
    store: f.store,
    audit: f.audit,
  });
  const outcome = await executeReviewed({
    approvalId,
    requestBytes: f.requestBytes,
    projectRoot: f.projectRoot,
    store: f.store,
    audit: f.audit,
    executor: async () => ({ exitCode: 7, timedOut: false }),
  });
  assert.equal(outcome.exitCode, 7);
  const records = await Promise.all(
    (await f.audit.listRecordPaths()).map(async (auditPath) =>
      JSON.parse(await readFile(auditPath, "utf8")),
    ),
  );
  const completion = records.find(
    (record) =>
      record.eventType === "execution" && record.reasonCode === "NONZERO_EXIT",
  );
  assert.equal(completion.outcome, "failed");
  assert.equal(completion.exitCode, 7);
  assert.equal(completion.errorCode, "NONZERO_EXIT");
});
