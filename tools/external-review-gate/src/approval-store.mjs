import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  link,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  parseRequestBytes,
  REQUEST_NONCE,
  sha256,
} from "./canonical.mjs";

const APPROVAL_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_KEYS = [
  "schemaVersion",
  "approvalId",
  "requestSha256",
  "commandSha256",
  "executableIdentitySha256",
  "cwdSha256",
  "projectRootSha256",
  "providerId",
  "riskLevel",
  "authLevel",
  "issuedAtMs",
  "expiresAtMs",
  "requestNonce",
  "approvalSalt",
  "runtimeSha256",
  "hmacSha256",
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export class ApprovalStore {
  constructor({
    directory,
    key,
    bootNonce = randomBytes(32),
    now = Date.now,
    ttlMs = 60_000,
    random = randomBytes,
  }) {
    if (!Buffer.isBuffer(key) || key.length < 32) {
      throw new Error("approval HMAC key must be at least 32 bytes");
    }
    if (!Buffer.isBuffer(bootNonce) || bootNonce.length < 32) {
      throw new Error("boot nonce must be at least 32 bytes");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
      throw new Error("approval TTL is invalid");
    }
    this.directory = path.resolve(directory);
    this.requestNonceDirectory = path.join(this.directory, "request-nonces");
    this.key = Buffer.from(key);
    this.runtimeSha256 = sha256(bootNonce);
    this.now = now;
    this.ttlMs = ttlMs;
    this.random = random;
  }

  #path(approvalId) {
    if (!APPROVAL_ID.test(approvalId)) {
      throw new Error("approval id is invalid");
    }
    return path.join(this.directory, `${approvalId}.json`);
  }

  #sign(record) {
    return createHmac("sha256", this.key)
      .update(canonicalJson(record), "utf8")
      .digest("hex");
  }

  async #reserveRequestNonce({ requestNonce, requestSha256, approvalId }) {
    if (
      typeof requestNonce !== "string" ||
      !REQUEST_NONCE.test(requestNonce)
    ) {
      throw new Error("request nonce is invalid");
    }
    await mkdir(this.requestNonceDirectory, { recursive: true });
    const markerPath = path.join(
      this.requestNonceDirectory,
      `${requestNonce}.json`,
    );
    try {
      await writeFile(
        markerPath,
        canonicalJson({
          schemaVersion: 1,
          requestNonce,
          requestSha256,
          approvalId,
        }),
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("request nonce was already issued");
      }
      throw error;
    }
  }

  async issue({ requestBytes, parsedRequest, review, providerId }) {
    const approvalId = this.random(16).toString("hex");
    const issuedAtMs = this.now();
    const unsigned = {
      schemaVersion: 1,
      approvalId,
      requestSha256: parsedRequest.requestSha256,
      commandSha256: parsedRequest.commandSha256,
      executableIdentitySha256: parsedRequest.executableIdentitySha256,
      cwdSha256: parsedRequest.cwdSha256,
      projectRootSha256: sha256(
        Buffer.from(parsedRequest.projectRoot, "utf8"),
      ),
      providerId,
      riskLevel: review.riskLevel,
      authLevel: review.authLevel,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
      requestNonce: parsedRequest.requestNonce,
      approvalSalt: this.random(16).toString("hex"),
      runtimeSha256: this.runtimeSha256,
    };
    if (sha256(requestBytes) !== unsigned.requestSha256) {
      throw new Error("request digest changed before approval issue");
    }
    const record = { ...unsigned, hmacSha256: this.#sign(unsigned) };
    await mkdir(this.directory, { recursive: true });
    await this.#reserveRequestNonce({
      requestNonce: parsedRequest.requestNonce,
      requestSha256: parsedRequest.requestSha256,
      approvalId,
    });
    const temporary = path.join(
      this.directory,
      `.${approvalId}.${this.random(8).toString("hex")}.tmp`,
    );
    await writeFile(temporary, canonicalJson(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(temporary, this.#path(approvalId));
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return approvalId;
  }

  async revoke(approvalId) {
    await unlink(this.#path(approvalId)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async consume({ approvalId, requestBytes, projectRoot }) {
    const approvalPath = this.#path(approvalId);
    let record;
    try {
      record = JSON.parse(await readFile(approvalPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("approval record is malformed");
      }
      throw error;
    }
    if (!exactKeys(record, RECORD_KEYS)) {
      throw new Error("approval record has the wrong fields");
    }
    const { hmacSha256, ...unsigned } = record;
    if (
      !SHA256.test(hmacSha256) ||
      !timingSafeEqual(
        Buffer.from(hmacSha256, "hex"),
        Buffer.from(this.#sign(unsigned), "hex"),
      )
    ) {
      throw new Error("approval signature mismatch");
    }
    if (record.runtimeSha256 !== this.runtimeSha256) {
      throw new Error("approval belongs to a different broker runtime");
    }
    const nowMs = this.now();
    if (
      record.schemaVersion !== 1 ||
      record.approvalId !== approvalId ||
      !SHA256.test(record.requestSha256) ||
      !SHA256.test(record.commandSha256) ||
      !SHA256.test(record.executableIdentitySha256) ||
      !SHA256.test(record.cwdSha256) ||
      !SHA256.test(record.projectRootSha256) ||
      !SHA256.test(record.runtimeSha256) ||
      typeof record.providerId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(record.providerId) ||
      !["low", "medium", "high", "critical"].includes(record.riskLevel) ||
      !["low", "medium", "high"].includes(record.authLevel) ||
      !Number.isSafeInteger(record.issuedAtMs) ||
      !Number.isSafeInteger(record.expiresAtMs) ||
      !REQUEST_NONCE.test(record.requestNonce) ||
      !/^[0-9a-f]{32}$/.test(record.approvalSalt) ||
      record.issuedAtMs > nowMs ||
      record.expiresAtMs - record.issuedAtMs !== this.ttlMs ||
      nowMs >= record.expiresAtMs
    ) {
      throw new Error("approval is invalid or expired");
    }

    const claimed = path.join(
      this.directory,
      `.${approvalId}.claimed.${process.pid}.${this.random(8).toString("hex")}`,
    );
    try {
      await rename(approvalPath, claimed);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) {
        throw new Error("approval was already consumed");
      }
      throw error;
    }
    try {
      const claimedBytes = await readFile(claimed);
      if (
        claimedBytes.length !== Buffer.byteLength(canonicalJson(record), "utf8") ||
        !timingSafeEqual(
          Buffer.from(sha256(claimedBytes), "hex"),
          Buffer.from(sha256(Buffer.from(canonicalJson(record), "utf8")), "hex"),
        )
      ) {
        throw new Error("approval record changed during atomic claim");
      }
      if (sha256(requestBytes) !== record.requestSha256) {
        throw new Error("request digest does not match reviewed bytes");
      }
      const parsedRequest = await parseRequestBytes(requestBytes, { projectRoot });
      if (
        parsedRequest.commandSha256 !== record.commandSha256 ||
        parsedRequest.executableIdentitySha256 !==
          record.executableIdentitySha256 ||
        parsedRequest.cwdSha256 !== record.cwdSha256 ||
        parsedRequest.requestNonce !== record.requestNonce ||
        sha256(Buffer.from(parsedRequest.projectRoot, "utf8")) !==
          record.projectRootSha256
      ) {
        throw new Error("canonical command or cwd digest mismatch");
      }
      return { record: Object.freeze(record), parsedRequest };
    } finally {
      await unlink(claimed).catch(() => {});
    }
  }
}
