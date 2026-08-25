import { sha256, parseRequestBytes, validateReviewResult, AUTH_LEVELS } from "./canonical.mjs";

class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  return Promise.race([
    Promise.resolve().then(() => operation(controller.signal)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new GateError("REVIEWER_TIMEOUT", "reviewer timed out"));
        },
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function validateProviderId(providerId) {
  if (
    typeof providerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)
  ) {
    throw new Error("reviewer provider id is invalid");
  }
  return providerId;
}

export async function reviewAndIssue({
  requestBytes,
  projectRoot,
  reviewer,
  store,
  audit,
  reviewTimeoutMs = 60_000,
}) {
  if (
    !Number.isSafeInteger(reviewTimeoutMs) ||
    reviewTimeoutMs < 1 ||
    reviewTimeoutMs > 120_000
  ) {
    throw new Error("review timeout is invalid");
  }
  let parsedRequest;
  let providerId = "";
  let result;
  try {
    providerId = validateProviderId(reviewer?.providerId);
    try {
      parsedRequest = await parseRequestBytes(requestBytes, { projectRoot });
    } catch {
      throw new GateError("REQUEST_INVALID", "request validation failed");
    }
    try {
      result = validateReviewResult(
        await withTimeout(
          (signal) =>
            reviewer.review({
              requestBytes: Buffer.from(requestBytes),
              requestSha256: parsedRequest.requestSha256,
              commandSha256: parsedRequest.commandSha256,
              executableIdentitySha256:
                parsedRequest.executableIdentitySha256,
              cwdSha256: parsedRequest.cwdSha256,
              requiredAuthLevel: parsedRequest.authLevel,
              requestNonce: parsedRequest.requestNonce,
              signal,
            }),
          reviewTimeoutMs,
        ),
      );
    } catch (error) {
      if (error instanceof GateError) throw error;
      throw new GateError("REVIEW_RESULT_INVALID", "reviewer failed or returned invalid data");
    }
    if (result.decision !== "allow") {
      throw new GateError("REVIEW_DENIED", "reviewer denied the request");
    }
    if (
      AUTH_LEVELS.indexOf(result.authLevel) <
      AUTH_LEVELS.indexOf(parsedRequest.authLevel)
    ) {
      throw new GateError(
        "AUTH_INSUFFICIENT",
        "review authorization was insufficient",
      );
    }
    await audit.append({
      eventType: "review",
      outcome: "allowed",
      requestSha256: parsedRequest.requestSha256,
      commandSha256: parsedRequest.commandSha256,
      cwdSha256: parsedRequest.cwdSha256,
      providerId,
      riskLevel: result.riskLevel,
      authLevel: result.authLevel,
      reasonCode: result.reasonCode,
    });
    return await store.issue({
      requestBytes,
      parsedRequest,
      review: result,
      providerId,
    });
  } catch (error) {
    const errorCode =
      error instanceof GateError ? error.code : "REVIEW_GATE_FAILURE";
    await audit.append({
      eventType: "review",
      outcome: "denied",
      requestSha256: parsedRequest?.requestSha256 ??
        (Buffer.isBuffer(requestBytes) ? sha256(requestBytes) : ""),
      commandSha256: parsedRequest?.commandSha256 ?? "",
      cwdSha256: parsedRequest?.cwdSha256 ?? "",
      providerId,
      riskLevel: result?.riskLevel ?? "",
      authLevel: result?.authLevel ?? "",
      reasonCode: "REVIEW_FAILED",
      errorCode,
    });
    throw new Error("external review gate failed closed", { cause: error });
  }
}

export async function executeReviewed({
  approvalId,
  requestBytes,
  projectRoot,
  store,
  audit,
  executor,
}) {
  let consumed;
  try {
    consumed = await store.consume({
      approvalId,
      requestBytes,
      projectRoot,
    });
  } catch (error) {
    const approvalIdHash =
      typeof approvalId === "string" && approvalId.length <= 128
        ? sha256(Buffer.from(approvalId, "utf8"))
        : "";
    try {
      await audit.append({
        eventType: "execution",
        outcome: "denied",
        requestSha256: Buffer.isBuffer(requestBytes)
          ? sha256(requestBytes)
          : "",
        commandSha256: "",
        cwdSha256: "",
        providerId: "",
        riskLevel: "",
        authLevel: "",
        reasonCode: "APPROVAL_CONSUME_REJECTED",
        approvalIdHash,
        errorCode: "CONSUME_REJECTED",
      });
    } catch (auditError) {
      throw new Error("pre-execution audit failed closed", {
        cause: auditError,
      });
    }
    throw new Error("approval consume failed closed", { cause: error });
  }
  const { record, parsedRequest } = consumed;
  const approvalIdHash = sha256(Buffer.from(approvalId, "ascii"));
  await audit.append({
    eventType: "execution",
    outcome: "started",
    requestSha256: parsedRequest.requestSha256,
    commandSha256: parsedRequest.commandSha256,
    cwdSha256: parsedRequest.cwdSha256,
    providerId: record.providerId,
    riskLevel: record.riskLevel,
    authLevel: record.authLevel,
    reasonCode: "APPROVAL_CONSUMED",
    approvalIdHash,
  });
  try {
    const outcome = await executor(parsedRequest);
    if (
      outcome === null ||
      typeof outcome !== "object" ||
      !Number.isInteger(outcome.exitCode) ||
      typeof outcome.timedOut !== "boolean"
    ) {
      throw new Error("executor returned an invalid outcome");
    }
    await audit.append({
      eventType: "execution",
      outcome:
        outcome.timedOut || outcome.exitCode !== 0 ? "failed" : "completed",
      requestSha256: parsedRequest.requestSha256,
      commandSha256: parsedRequest.commandSha256,
      cwdSha256: parsedRequest.cwdSha256,
      providerId: record.providerId,
      riskLevel: record.riskLevel,
      authLevel: record.authLevel,
      reasonCode: outcome.timedOut
        ? "EXECUTION_TIMEOUT"
        : outcome.exitCode !== 0
          ? "NONZERO_EXIT"
          : "EXECUTION_FINISHED",
      approvalIdHash,
      errorCode: outcome.timedOut
        ? "TIMEOUT"
        : outcome.exitCode !== 0
          ? "NONZERO_EXIT"
          : "",
      exitCode: outcome.exitCode,
    });
    return outcome;
  } catch (error) {
    await audit.append({
      eventType: "execution",
      outcome: "failed",
      requestSha256: parsedRequest.requestSha256,
      commandSha256: parsedRequest.commandSha256,
      cwdSha256: parsedRequest.cwdSha256,
      providerId: record.providerId,
      riskLevel: record.riskLevel,
      authLevel: record.authLevel,
      reasonCode: "EXECUTOR_FAILURE",
      approvalIdHash,
      errorCode: "EXECUTOR_ERROR",
      exitCode: null,
    });
    throw error;
  }
}
