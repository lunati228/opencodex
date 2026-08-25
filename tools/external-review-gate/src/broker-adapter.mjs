import { executeReviewed, reviewAndIssue } from "./gate.mjs";

const EXTERNAL_REQUEST_KEYS = Object.freeze([
  "version",
  "executable",
  "argv",
  "cwd",
  "timeoutMs",
  "authLevel",
  "requestNonce",
]);

function hasExactExternalRequestKeys(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") ===
      [...EXTERNAL_REQUEST_KEYS].sort().join("\0")
  );
}

/**
 * Inactive broker-facing boundary.
 *
 * A future MCP wrapper may pass only the structured request object to `run`.
 * The approval identifier is created, consumed, and discarded inside this
 * adapter. It is never accepted from or returned to the external caller.
 */
export class InactiveBrokerAdapter {
  constructor({
    projectRoot,
    reviewer,
    store,
    audit,
    executor,
    reviewTimeoutMs = 60_000,
  }) {
    if (
      typeof projectRoot !== "string" ||
      projectRoot.length === 0 ||
      !reviewer ||
      !store ||
      !audit ||
      typeof executor !== "function"
    ) {
      throw new Error("inactive broker adapter configuration is invalid");
    }
    this.projectRoot = projectRoot;
    this.reviewer = reviewer;
    this.store = store;
    this.audit = audit;
    this.executor = executor;
    this.reviewTimeoutMs = reviewTimeoutMs;
  }

  async run(request) {
    if (!hasExactExternalRequestKeys(request)) {
      throw new Error(
        "broker request has the wrong fields; approval identifiers are broker-private",
      );
    }
    const requestBytes = Buffer.from(
      JSON.stringify({
        version: request.version,
        executable: request.executable,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        authLevel: request.authLevel,
        requestNonce: request.requestNonce,
      }),
      "utf8",
    );
    const approvalId = await reviewAndIssue({
      requestBytes,
      projectRoot: this.projectRoot,
      reviewer: this.reviewer,
      store: this.store,
      audit: this.audit,
      reviewTimeoutMs: this.reviewTimeoutMs,
    });
    return executeReviewed({
      approvalId,
      requestBytes,
      projectRoot: this.projectRoot,
      store: this.store,
      audit: this.audit,
      executor: this.executor,
    });
  }
}

export { EXTERNAL_REQUEST_KEYS };
