import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";

const EVENT_KEYS = [
  "schemaVersion",
  "sequence",
  "previousRecordSha256",
  "eventId",
  "timestampMs",
  "eventType",
  "outcome",
  "requestSha256",
  "commandSha256",
  "cwdSha256",
  "providerId",
  "riskLevel",
  "authLevel",
  "reasonCode",
  "approvalIdHash",
  "errorCode",
  "exitCode",
  "hmacSha256",
];
const HEAD_KEYS = [
  "schemaVersion",
  "sequence",
  "headSha256",
  "hmacSha256",
];
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA_OR_EMPTY = /^(?:[0-9a-f]{64})?$/;
const RECORD_FILENAME = /^[0-9]{12}-[0-9a-f]{32}\.json$/;
const HEAD_FILENAME = "audit-head.json";
const WRITER_LOCK_DIRECTORY = ".audit-writer.lock";

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function safeTimingEqual(left, right) {
  return (
    typeof left === "string" &&
    /^[0-9a-f]{64}$/.test(left) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export class AuditLog {
  constructor({ directory, key, now = Date.now, random = randomBytes }) {
    if (!Buffer.isBuffer(key) || key.length < 32) {
      throw new Error("audit HMAC key must be at least 32 bytes");
    }
    this.directory = path.resolve(directory);
    this.headPath = path.join(this.directory, HEAD_FILENAME);
    this.writerLockPath = path.join(this.directory, WRITER_LOCK_DIRECTORY);
    this.key = Buffer.from(key);
    this.now = now;
    this.random = random;
    this.tail = Promise.resolve();
  }

  async append(fields) {
    const snapshot = { ...fields };
    const operation = this.tail.then(() =>
      this.#withWriterLock(() => this.#append(snapshot)),
    );
    this.tail = operation.catch(() => {});
    return operation;
  }

  #signRecord(record) {
    return createHmac("sha256", this.key)
      .update("external-review-audit-record-v1\0", "utf8")
      .update(canonicalJson(record), "utf8")
      .digest("hex");
  }

  #signHead(head) {
    return createHmac("sha256", this.key)
      .update("external-review-audit-head-v1\0", "utf8")
      .update(canonicalJson(head), "utf8")
      .digest("hex");
  }

  async #withWriterLock(operation) {
    await mkdir(this.directory, { recursive: true });
    try {
      await mkdir(this.writerLockPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("audit writer lock already exists");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.writerLockPath);
    }
  }

  #validateRecord(record) {
    if (
      !exactKeys(record, EVENT_KEYS) ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      !SHA_OR_EMPTY.test(record.previousRecordSha256) ||
      !/^[0-9a-f]{32}$/.test(record.eventId) ||
      !Number.isSafeInteger(record.timestampMs) ||
      !["review", "execution"].includes(record.eventType) ||
      !["allowed", "denied", "started", "completed", "failed"].includes(
        record.outcome,
      ) ||
      ![
        record.requestSha256,
        record.commandSha256,
        record.cwdSha256,
        record.approvalIdHash,
      ].every((value) => SHA_OR_EMPTY.test(value)) ||
      (record.providerId !== "" && !SAFE_PROVIDER.test(record.providerId)) ||
      !["", "low", "medium", "high", "critical"].includes(record.riskLevel) ||
      !["", "low", "medium", "high"].includes(record.authLevel) ||
      (record.reasonCode !== "" && !SAFE_CODE.test(record.reasonCode)) ||
      (record.errorCode !== "" && !SAFE_CODE.test(record.errorCode)) ||
      !(
        record.exitCode === null ||
        (Number.isSafeInteger(record.exitCode) &&
          record.exitCode >= -2147483648 &&
          record.exitCode <= 2147483647)
      )
    ) {
      throw new Error("audit record contains an unsafe or invalid field");
    }
  }

  async #readExpectedHead(recordPaths) {
    let head;
    try {
      head = JSON.parse(await readFile(this.headPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        if (recordPaths.length > 0) {
          throw new Error("audit expected head is missing");
        }
        return { sequence: 0, headSha256: "" };
      }
      if (error instanceof SyntaxError) {
        throw new Error("audit expected head is malformed");
      }
      throw error;
    }
    if (
      !exactKeys(head, HEAD_KEYS) ||
      head.schemaVersion !== 1 ||
      !Number.isSafeInteger(head.sequence) ||
      head.sequence < 1 ||
      !/^[0-9a-f]{64}$/.test(head.headSha256)
    ) {
      throw new Error("audit expected head is invalid");
    }
    const { hmacSha256, ...unsigned } = head;
    if (!safeTimingEqual(hmacSha256, this.#signHead(unsigned))) {
      throw new Error("audit head HMAC verification failed");
    }
    return { sequence: head.sequence, headSha256: head.headSha256 };
  }

  async #loadAndVerify() {
    const recordPaths = await this.listRecordPaths();
    const expectedHead = await this.#readExpectedHead(recordPaths);
    let previous = "";
    let expectedSequence = 1;
    for (const recordPath of recordPaths) {
      let record;
      try {
        record = JSON.parse(await readFile(recordPath, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error("audit record is malformed");
        }
        throw error;
      }
      this.#validateRecord(record);
      const { hmacSha256, ...unsigned } = record;
      const expectedFilename =
        `${String(record.sequence).padStart(12, "0")}-${record.eventId}.json`;
      if (
        !safeTimingEqual(hmacSha256, this.#signRecord(unsigned)) ||
        record.sequence !== expectedSequence ||
        record.previousRecordSha256 !== previous ||
        path.basename(recordPath) !== expectedFilename
      ) {
        throw new Error("audit HMAC or chain verification failed");
      }
      previous = sha256(Buffer.from(canonicalJson(record), "utf8"));
      expectedSequence += 1;
    }
    const actualSequence = expectedSequence - 1;
    if (
      expectedHead.sequence !== actualSequence ||
      expectedHead.headSha256 !== previous
    ) {
      throw new Error("audit expected head does not match the record chain");
    }
    return { sequence: actualSequence, headSha256: previous };
  }

  async #writeExpectedHead(sequence, headSha256) {
    const unsigned = {
      schemaVersion: 1,
      sequence,
      headSha256,
    };
    const head = {
      ...unsigned,
      hmacSha256: this.#signHead(unsigned),
    };
    const temporary = path.join(
      this.directory,
      `.${HEAD_FILENAME}.${this.random(8).toString("hex")}.tmp`,
    );
    await writeFile(temporary, canonicalJson(head), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, this.headPath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async #append(fields) {
    const verified = await this.#loadAndVerify();
    const sequence = verified.sequence + 1;
    const unsigned = {
      schemaVersion: 1,
      sequence,
      previousRecordSha256: verified.headSha256,
      eventId: this.random(16).toString("hex"),
      timestampMs: this.now(),
      eventType: fields.eventType,
      outcome: fields.outcome,
      requestSha256: fields.requestSha256 ?? "",
      commandSha256: fields.commandSha256 ?? "",
      cwdSha256: fields.cwdSha256 ?? "",
      providerId: fields.providerId ?? "",
      riskLevel: fields.riskLevel ?? "",
      authLevel: fields.authLevel ?? "",
      reasonCode: fields.reasonCode ?? "",
      approvalIdHash: fields.approvalIdHash ?? "",
      errorCode: fields.errorCode ?? "",
      exitCode: fields.exitCode ?? null,
    };
    const record = {
      ...unsigned,
      hmacSha256: this.#signRecord(unsigned),
    };
    this.#validateRecord(record);
    const basename =
      `${String(sequence).padStart(12, "0")}-${record.eventId}.json`;
    const finalPath = path.join(this.directory, basename);
    const temporary = path.join(
      this.directory,
      `.${basename}.${this.random(8).toString("hex")}.tmp`,
    );
    await writeFile(temporary, canonicalJson(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, finalPath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    const recordSha256 = sha256(
      Buffer.from(canonicalJson(record), "utf8"),
    );
    await this.#writeExpectedHead(sequence, recordSha256);
    return finalPath;
  }

  async listRecordPaths() {
    const names = await readdir(this.directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names
      .filter((name) => RECORD_FILENAME.test(name))
      .sort()
      .map((name) => path.join(this.directory, name));
  }

  async verify() {
    const operation = this.tail.then(() =>
      this.#withWriterLock(() => this.#loadAndVerify()),
    );
    this.tail = operation.catch(() => {});
    const verified = await operation;
    return {
      records: verified.sequence,
      headSha256: verified.headSha256,
    };
  }
}
