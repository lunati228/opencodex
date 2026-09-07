import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "../lib/local-management-attestation";

/** Bodyless companion operations only; never a general management or inference credential. */
export type CompanionLifecyclePath = "/api/local-runtime/stop" | "/api/stop?keep-codex-routing=1";
interface LocalIdentity { attestationSecret: string; pid: number; port: number }
const PREFIX = "x-ocx-companion-";
const TTL_MS = 30_000;
const consumed = new Map<string, number>();
const admitted = new WeakSet<Request>();

function signature(local: LocalIdentity, path: string, nonce: string, expiresAt: number): string {
  return createHmac("sha256", local.attestationSecret)
    .update(JSON.stringify(["local-runtime-lifecycle-v1", "POST", path, local.pid, local.port, nonce, expiresAt]))
    .digest("base64url");
}

export function createCompanionLifecycleHeaders(
  local: LocalIdentity, path: CompanionLifecyclePath, now = Date.now(),
): Headers {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now + TTL_MS;
  return new Headers({
    "content-length": "0", [PREFIX + "pid"]: String(local.pid),
    [PREFIX + "nonce"]: nonce, [PREFIX + "expires"]: String(expiresAt),
    [PREFIX + "proof"]: signature(local, path, nonce, expiresAt),
  });
}

export function admitCompanionLifecycle(req: Request, local?: LocalIdentity): boolean {
  if (admitted.has(req)) return true;
  if (!local || !isLocalAttestationSecret(local.attestationSecret) || req.method !== "POST"
    || req.headers.get("content-length") !== "0" || req.headers.has("transfer-encoding")) return false;
  const url = new URL(req.url);
  const path = url.pathname + url.search;
  if (path !== "/api/local-runtime/stop" && path !== "/api/stop?keep-codex-routing=1") return false;
  if (req.headers.get(PREFIX + "pid") !== String(local.pid)) return false;
  const nonce = req.headers.get(PREFIX + "nonce");
  const proof = req.headers.get(PREFIX + "proof");
  const expiry = req.headers.get(PREFIX + "expires");
  if (!nonce || !proof || !isLocalAttestationSecret(nonce) || !isLocalAttestationSecret(proof)
    || !expiry || !/^[1-9]\d*$/.test(expiry)) return false;
  const expiresAt = Number(expiry);
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + TTL_MS) return false;
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(signature(local, path, nonce, expiresAt)))) return false;
  for (const [key, until] of consumed) if (until <= now) consumed.delete(key);
  const key = createHash("sha256").update(proof).digest("base64url");
  if (consumed.has(key) || consumed.size >= 256) return false;
  consumed.set(key, expiresAt);
  admitted.add(req);
  return true;
}
