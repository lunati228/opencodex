import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  getLocalRuntimeProfile, isLocalRuntimeProfileId, LOCAL_RUNTIME_HOST, LOCAL_RUNTIME_PORT,
  validateLocalRuntimeCandidate, type LocalRuntimeReasoningEffort,
} from "./profile";
import type { LocalRuntimeStatus } from "./supervisor";

export const CONSUMER_LEASE_TTL_MS = 90_000;
export const CONSUMER_LEASE_HEARTBEAT_MS = 30_000;
export const CONSUMER_OWNER_HEADER = "x-ocx-consumer-owner";
export const CONSUMER_LEASE_API_PATH = "/api/local-runtime/v1/leases/";
const MAX_CONSUMER_LEASES = 128;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface ConsumerLeaseStatus {
  /** Unix milliseconds projected from the remaining monotonic lifetime. */
  expiresAt: number;
  modelUse: boolean;
}

interface ConsumerLeaseEntry {
  /** Monotonic milliseconds; never compared with the wall clock. */
  deadline: number;
  modelUse: boolean;
}

export interface ConsumerLeaseSnapshot {
  proxyHolds: number;
  modelHolds: number;
  /** Current Unix-ms projection for the existing wall-clock idle observer. */
  lastModelUseAt: number | null;
}

/** In-memory, bounded ownership. No raw token, owner, request, or tombstone is retained. */
export class ConsumerLeaseRegistry {
  private readonly signingKey = randomBytes(32);
  private readonly entries = new Map<string, ConsumerLeaseEntry>();
  // Store elapsed-time ordering even when the wall clock moves backward.
  private lastModelUseAt: number | null = null;
  private suspended = 0;

  constructor(
    private readonly wallNow: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  private signature(owner: string, nonce: string): string {
    return createHmac("sha256", this.signingKey)
      .update(JSON.stringify(["local-runtime-consumer-v1", owner, nonce])).digest("base64url");
  }

  private key(owner: string, token: string): string | null {
    if (typeof token !== "string" || token.length !== 87) return null;
    const [nonce, signature] = token.split(".");
    if (!nonce || !signature || !SECRET_SHAPE.test(nonce) || !SECRET_SHAPE.test(signature)) return null;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(owner, nonce)))) return null;
    return createHash("sha256").update(token).digest("base64url");
  }

  private settle(at: number): void {
    this.lastModelUseAt = Math.max(this.lastModelUseAt ?? at, at);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.deadline > now) continue;
      if (entry.modelUse) this.settle(entry.deadline);
      this.entries.delete(key);
    }
  }

  private publicStatus(entry: ConsumerLeaseEntry, now: number): ConsumerLeaseStatus {
    return {
      expiresAt: this.wallNow() + Math.ceil(entry.deadline - now),
      modelUse: entry.modelUse,
    };
  }

  acquire(owner: string, modelUse: boolean): (ConsumerLeaseStatus & { leaseToken: string }) | null {
    const now = this.monotonicNow();
    this.prune(now);
    if (this.suspended || this.entries.size >= MAX_CONSUMER_LEASES) return null;
    const nonce = randomBytes(32).toString("base64url");
    const leaseToken = `${nonce}.${this.signature(owner, nonce)}`;
    const entry = { deadline: now + CONSUMER_LEASE_TTL_MS, modelUse };
    this.entries.set(this.key(owner, leaseToken)!, entry);
    return { ...this.publicStatus(entry, now), leaseToken };
  }

  status(owner: string, token: string): ConsumerLeaseStatus | null {
    const now = this.monotonicNow();
    this.prune(now);
    const key = this.key(owner, token);
    const entry = key ? this.entries.get(key) : undefined;
    return entry ? this.publicStatus(entry, now) : null;
  }

  heartbeat(owner: string, token: string, modelUse?: boolean): ConsumerLeaseStatus | null {
    const now = this.monotonicNow();
    this.prune(now);
    const key = this.key(owner, token);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) return null;
    if (modelUse !== undefined) {
      if (entry.modelUse && !modelUse) this.settle(now);
      entry.modelUse = modelUse;
    }
    entry.deadline = now + CONSUMER_LEASE_TTL_MS;
    return this.publicStatus(entry, now);
  }

  release(owner: string, token: string): boolean {
    const now = this.monotonicNow();
    this.prune(now);
    const key = this.key(owner, token);
    if (!key) return false;
    const entry = this.entries.get(key);
    if (entry?.modelUse) this.settle(now);
    this.entries.delete(key);
    // The owner-bound MAC still verifies after release/expiry; no tombstones are needed.
    return true;
  }

  snapshot(): ConsumerLeaseSnapshot {
    const now = this.monotonicNow();
    this.prune(now);
    let modelHolds = 0;
    for (const entry of this.entries.values()) if (entry.modelUse) modelHolds++;
    // Re-project the settled-use age on every observation. Copying a monotonic
    // timestamp here would mix clock units in shouldReleaseIdleLocalRuntime;
    // retaining an old wall timestamp would reintroduce clock-correction drift.
    const lastModelUseAt = this.lastModelUseAt === null
      ? null : this.wallNow() - (now - this.lastModelUseAt);
    return { proxyHolds: this.entries.size, modelHolds, lastModelUseAt };
  }

  clearModelUse(): void {
    if (this.snapshot().modelHolds === 0) this.lastModelUseAt = null;
  }

  /** Reserve shutdown before any asynchronous teardown; a refusal releases this fence. */
  suspendAcquisition(): () => void {
    this.suspended++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspended--;
    };
  }
}

export const managedLocalRuntimeConsumerLeases = new ConsumerLeaseRegistry();

/** The auth gate must already have admitted the credential. An owner header is not admission. */
export function consumerLeaseOwner(req: Request): string | null {
  const owner = req.headers.get(CONSUMER_OWNER_HEADER);
  const credential = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!owner || !SECRET_SHAPE.test(owner) || !credential) return null;
  return createHash("sha256").update(JSON.stringify([credential, owner])).digest("base64url");
}

export interface VerifiedLocalRuntimeDescriptor {
  endpoint: string;
  model: string;
  contextWindow: number;
  reasoningEffort: LocalRuntimeReasoningEffort;
}

/** Allowlist projection from a currently owned and verified supervisor, never provider routing. */
export function verifiedLocalRuntimeDescriptor(
  status: LocalRuntimeStatus, canRoute: boolean,
): VerifiedLocalRuntimeDescriptor | null {
  const effective = status.effective;
  if (!canRoute || status.operationPending || !effective
    || (status.state !== "running" && status.state !== "rolled-back")
    || !Number.isSafeInteger(status.pid) || status.pid! <= 0
    || !isLocalRuntimeProfileId(effective.profileId)
    || typeof effective.verifiedAt !== "string" || !Number.isFinite(Date.parse(effective.verifiedAt))) return null;
  const profile = getLocalRuntimeProfile(effective.profileId);
  if (effective.model !== profile.modelId || !profile.reasoningEfforts.includes(effective.reasoningEffort)) return null;
  try {
    const candidate = validateLocalRuntimeCandidate(effective);
    if (candidate.reasoningEffort !== effective.reasoningEffort) return null;
    return {
      endpoint: `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}/v1`,
      model: profile.modelId, contextWindow: candidate.nCtx, reasoningEffort: candidate.reasoningEffort,
    };
  } catch {
    return null;
  }
}
