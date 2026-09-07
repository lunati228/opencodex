import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createCompanionLifecycleHeaders } from "../src/local-runtime/companion-lifecycle-auth";
import { requireManagementAuth, managementPrincipal } from "../src/server/management-auth";
import { requestCompanionLifecycle } from "../src/codex/companion-runtime";
import { createLocalAttestationProof, LOCAL_ATTESTATION_PROOF_HEADER, LOCAL_ATTESTATION_CHALLENGE_HEADER } from "../src/lib/local-management-attestation";

const secret = () => randomBytes(32).toString("base64url");

describe("companion process-bound lifecycle authentication", () => {
  test("capability admits exactly one bodyless stop against the matching proxy", () => {
    const local = { attestationSecret: secret(), pid: 1234, port: 10100 };
    const path = "/api/local-runtime/stop";
    const headers = createCompanionLifecycleHeaders(local, path);
    const req = new Request(`http://127.0.0.1:10100${path}`, { method: "POST", headers });
    const auth = { available: false as const, reason: "fixture" };
    expect(requireManagementAuth(req, auth, undefined, local)).toBeNull();
    expect(managementPrincipal(req, auth, undefined, local)).toBe("local-runtime-lifecycle-capability");
    const replay = new Request(req.url, { method: "POST", headers });
    expect(requireManagementAuth(replay, auth, undefined, local)).not.toBeNull();
    for (const other of ["/api/local-runtime/start", "/api/stop", "/api/local-runtime/v1/leases/acquire"]) {
      expect(requireManagementAuth(new Request(`http://127.0.0.1:10100${other}`, { method: "POST", headers }), auth, undefined, local)).not.toBeNull();
    }
  });

  test("rejects wrong PID, expired capability, method, query and request body", () => {
    const local = { attestationSecret: secret(), pid: 1234, port: 10100 };
    const auth = { available: false as const, reason: "fixture" };
    const path = "/api/stop?keep-codex-routing=1";
    for (const variant of ["pid", "expiry", "method", "query", "body"]) {
      const headers = createCompanionLifecycleHeaders(local, path, variant === "expiry" ? Date.now() - 31_000 : Date.now());
      if (variant === "body") headers.set("content-length", "2");
      const req = new Request(`http://127.0.0.1:10100${variant === "query" ? path + "&extra=1" : path}`, {
        method: variant === "method" ? "GET" : "POST", headers,
        ...(variant === "body" ? { body: "{}" } : {}),
      });
      expect(requireManagementAuth(req, auth, undefined, variant === "pid" ? { ...local, pid: 4321 } : local)).not.toBeNull();
    }
  });

  test("companion proves listener identity before POST and never sends an admin bearer", async () => {
    const attestationSecret = secret();
    const target = { pid: 1234, port: 10100, hostname: "127.0.0.1", source: "runtime" as const };
    let posts = 0;
    const response = await requestCompanionLifecycle(target, "/api/local-runtime/stop", {
      readRuntime: () => ({ ...target, attestationSecret }),
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("x-opencodex-api-key")).toBe(false);
        if (init?.method === "POST") { posts++; return new Response(null, { status: 409 }); }
        expect(String(input)).toBe("http://127.0.0.1:10100/healthz");
        const proof = createLocalAttestationProof(attestationSecret, headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!, target.pid, target.port)!;
        return Response.json({ service: "opencodex", pid: target.pid, version: "test", uptime: 1 }, { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } });
      },
    });
    expect(response.status).toBe(409);
    expect(posts).toBe(1);
  });

  test("foreign listener and remote target get no lifecycle mutation", async () => {
    let posts = 0;
    for (const hostname of ["127.0.0.1", "example.com"]) {
      const target = { pid: 1234, port: 10100, hostname, source: "runtime" as const };
      await expect(requestCompanionLifecycle(target, "/api/local-runtime/stop", {
        readRuntime: () => ({ ...target, attestationSecret: secret() }),
        fetchImpl: async (_input, init) => {
          if (init?.method === "POST") posts++;
          return Response.json({ service: "opencodex", pid: target.pid, version: "test", uptime: 1 });
        },
      })).rejects.toThrow("companion_lifecycle_unverified");
    }
    expect(posts).toBe(0);
  });

  test("real direct loopback transport carries a bodyless capability without reusable credentials", async () => {
    const attestationSecret = secret();
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          const proof = createLocalAttestationProof(attestationSecret, req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!, process.pid, server.port!)!;
          return Response.json({}, { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } });
        }
        expect(req.headers.has("authorization")).toBe(false);
        expect(req.headers.has("x-opencodex-api-key")).toBe(false);
        const denied = requireManagementAuth(req, { available: false, reason: "fixture" }, undefined,
          { attestationSecret, pid: process.pid, port: server.port! });
        return denied ?? Response.json({ accepted: false, reason: "consumer-in-use" }, { status: 409 });
      },
    });
    try {
      const target = { pid: process.pid, port: server.port!, hostname: "127.0.0.1", source: "runtime" as const };
      const response = await requestCompanionLifecycle(target, "/api/local-runtime/stop", {
        readRuntime: () => ({ ...target, attestationSecret }),
      });
      expect(response.status).toBe(409);
    } finally { await server.stop(true); }
  });
});
