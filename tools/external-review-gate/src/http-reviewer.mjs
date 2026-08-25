import { CircuitBreaker, reviewWithRetry } from "./resilience.mjs";
import { REQUEST_NONCE, validateReviewResult } from "./canonical.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function parseBoundedJson(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    typeof contentLength === "string" &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("review provider response is oversized");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("review provider response cannot be read safely");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        throw new Error("review provider response chunk is invalid");
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("review provider response is oversized");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  if (bytes.length === 0) {
    throw new Error("review provider response is empty or oversized");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("review provider response is not valid UTF-8 JSON");
  }
}

export class JsonHttpReviewer {
  constructor({
    providerId,
    endpoint,
    headers = {},
    fetchImpl = fetch,
    circuitBreaker = new CircuitBreaker(),
    retry = {},
  }) {
    if (
      typeof providerId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)
    ) {
      throw new Error("review provider id is invalid");
    }
    const parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== "https:") {
      throw new Error("review provider endpoint must use HTTPS");
    }
    if (parsedEndpoint.username || parsedEndpoint.password) {
      throw new Error("review provider endpoint cannot contain credentials");
    }
    if (
      headers === null ||
      typeof headers !== "object" ||
      Array.isArray(headers)
    ) {
      throw new Error("review provider headers are invalid");
    }
    this.providerId = providerId;
    this.endpoint = parsedEndpoint.toString();
    this.headers = Object.freeze({ ...headers });
    this.fetchImpl = fetchImpl;
    this.circuitBreaker = circuitBreaker;
    this.retry = Object.freeze({ ...retry });
  }

  async review({
    requestBytes,
    requestSha256,
    commandSha256,
    executableIdentitySha256,
    cwdSha256,
    requiredAuthLevel,
    requestNonce,
    signal,
  }) {
    if (!Buffer.isBuffer(requestBytes)) {
      throw new TypeError("review request bytes must be a Buffer");
    }
    if (
      ![
        requestSha256,
        commandSha256,
        executableIdentitySha256,
        cwdSha256,
      ].every((value) =>
        /^[0-9a-f]{64}$/.test(value),
      ) ||
      !["low", "medium", "high"].includes(requiredAuthLevel) ||
      typeof requestNonce !== "string" ||
      !REQUEST_NONCE.test(requestNonce)
    ) {
      throw new Error("review request metadata is invalid");
    }
    const body = JSON.stringify({
      schemaVersion: 1,
      requestBase64: requestBytes.toString("base64"),
      requestSha256,
      commandSha256,
      executableIdentitySha256,
      cwdSha256,
      requiredAuthLevel,
      requestNonce,
    });
    return reviewWithRetry({
      ...this.retry,
      circuitBreaker: this.circuitBreaker,
      parseResponse: parseBoundedJson,
      validateResponse: validateReviewResult,
      signal,
      send: () =>
        this.fetchImpl(this.endpoint, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            ...this.headers,
            "content-type": "application/json",
          },
          body,
        }),
    });
  }
}
