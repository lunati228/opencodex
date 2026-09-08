# OpenCodex integration fork

This fork adds a privacy-conscious managed local runtime, external review, and
automatic compaction while retaining OpenCodex's public routing behavior.

## Branch and history contract

`auto-compact-n-review` is the fork's integration branch. Its merge history
keeps both the fork tip and canonical `lidge-jun/opencodex:main` as parents; the
fork changes are not squashed, rebased, or copied into an unrelated history.
`ornith-setup` remains available as a rollback reference.

The current integration includes canonical main through 2.42.0. GPT-6 Astra
uses its own upstream catalog row, context ceiling, and reasoning ladder;
it does not inherit Sol's identity or context limit. Gemini 3.8 Flash is the
current Antigravity Flash selection. Older identifiers remain supported at
compatibility boundaries and in historical records.

For mixed native/routed delegation, `multiAgentMode: "v2"` together with
`keepNativeChatGptOnV1: true` keeps native assignments plaintext while routed
models retain the V2 tool surface. The global Codex V2 override must be off.
These catalog settings apply to new tasks; they do not rewrite an existing
task's tool surface. Unreadable encrypted native assignments still fail closed.

## Public local-runtime contract

The managed Qwen profile has a 180K (184,320-token) default context window and
an explicit 128K (131,072-token) lower-memory row. Qwen agent work defaults to
xhigh reasoning; this managed picker intentionally exposes exactly low,
medium, and xhigh. Saved obsolete local reasoning values normalize only at the
compatibility boundary.

Machine-specific launch configuration is loaded from an ignored local runtime
profile. Public source and documentation intentionally omit artifact paths,
hashes, sizes, device placement, hardware topology, capacity, measurements,
logs, screenshots, credentials, account data, and recovery layout.

The managed local listener remains loopback-only. A local Qwen run is never
implied by configuration changes and requires explicit operator authorization.
An on-demand request waits only while the supervisor is still starting or
restarting. A terminal launch, readiness, stop, rollback, or foreign-listener
failure returns a sanitized 503 on the next readiness poll instead of leaving
the Codex turn apparently active until the cold-load timeout.

### Local consumer leases (management API v1)

Harness consumers acquire an in-memory lease before direct local inference.
Use the independent management credential only on the verified management
origin, plus `X-OCX-Consumer-Owner`, a client-generated 32-byte unpadded base64url
secret. Keep that owner secret stable for the lease lifetime. Tokens bind to
both this owner and the admitted management credential. They do not authorize
inference or any other management action.

All four operations use POST with JSON bodies:

| Path | Body |
| --- | --- |
| `/api/local-runtime/v1/leases/acquire` | `{ "modelUse": true }` or `{ "modelUse": false }` |
| `/api/local-runtime/v1/leases/heartbeat` | `{ "leaseToken": "…", "modelUse": true }`; `modelUse` may be omitted to preserve the hold |
| `/api/local-runtime/v1/leases/status` | `{ "leaseToken": "…" }`; does not renew or start the model |
| `/api/local-runtime/v1/leases/release` | `{ "leaseToken": "…" }`; idempotent within the proxy lifetime |

Acquire, heartbeat, and status return this allowlisted shape, with no-store
caching. Only acquire returns `leaseToken`:

```ts
{
  version: 1,
  ttlMs: 90000,
  heartbeatMs: 30000,
  expiresAt: number, // Unix milliseconds
  modelUse: boolean,
  state: "ready" | "loading" | "idle",
  runtime: null | {
    endpoint: string, // verified numeric-loopback HTTP base ending in /v1
    model: string,
    contextWindow: number,
    reasoningEffort: "off" | "low" | "medium" | "xhigh",
    supportsVision?: boolean // only true authorizes image input
  },
  leaseToken?: string
}
```

Loading returns 202 without an endpoint; ready or idle returns 200. Release
returns `{ "version": 1, "released": true }`. Invalid input returns 400,
missing management admission 401, and unknown, expired, or wrong-owner leases
404. Unavailable, disabled, foreign, or unverified runtimes return a sanitized
503; release remains available. The registry accepts at most 128 live leases.
No lease state is persisted or logged. Restart invalidates all lease tokens.

`supportsVision` is captured during the identity-verified readiness probe only
when `/props` reports `is_sleeping: false` and an object-valued `modalities`
with `vision: true`. The consumer projection returns `false` when that evidence
is absent, false, malformed, or sleeping; text readiness is unchanged. Older
descriptors may omit the field, which clients must treat as false. Model labels,
launch arguments, and generic `multimodal` capabilities do not establish vision.
This is readiness-time evidence, not a continuous residency or per-image success
guarantee. The protocol reference is upstream llama.cpp
[b10549 server-context.cpp](https://github.com/ggml-org/llama.cpp/blob/b2e5e9b28b2484fbf94b543432ece638996a8b97/tools/server/server-context.cpp):
`allow_image` derives from initialized `mtmd_support_vision`, and sleeping
responses retain capability metadata while setting `is_sleeping` to true.

Every live lease protects proxy ownership. `modelUse: true` also holds the
model while a consumer is queued or running. Heartbeat every 30 seconds; an
unrenewed lease expires after 90 seconds. Final model-use release or expiry
starts the existing five-minute idle window, checked every 30 seconds. A
proxy-only lease can keep management available while this idle sweep releases
the model. Manual starts with no observed use retain their idle exception.

Lease lifetime, heartbeat eligibility, and settled consumer-use age use a
monotonic clock. Wall-clock corrections do not shorten or extend these
intervals. `expiresAt` remains a Unix-millisecond projection of the remaining
lifetime; a status response can adjust that projection without renewing the
lease. The idle observer receives the settled-use age projected into its
current Unix clock, so its existing timestamp comparisons keep the same units.

Companion close and explicit model/proxy stop refuse while any consumer lease
remains. Restart and context changes cannot silently interrupt an active
consumer. The companion retries busy operations and authenticates its exact
stop operations with short-lived, one-use, process-bound capabilities.

Research inference uses the verified model endpoint directly. The consumer
must restrict its transport to that exact origin and `/v1/chat/completions`,
reject redirects, and keep `modelUse: true` until queued and active inference
settles. This management API adds no research inference route or cloud
fallback. Lease protection coordinates normal lifecycle actions; it cannot
prevent an operating-system force kill or machine shutdown. Client integration
and a live model run require separate validation.

## Integrated routing behavior

- Ordinary routed reasoning models retain OpenCodex's validation-safe `max`
  and `ultra` picker tiers. `ultra` is an orchestration/product tier, and both
  synthetic tiers are clamped at the provider boundary to the model's actual
  highest supported wire effort.
- Exact combo capability intersections and the managed Qwen profile remain
  exact where their runtime contract requires it.
- Upstream blocked-model redirects run after the fork's external-provider and
  managed-local readiness checks, so a redirect does not bypass either safety
  boundary.
- Shadow-call interception compares the resolved source and target route. A
  physical self-target is a no-op, and an actual reroute preserves the caller's
  configured reasoning effort unless the helper-turn policy explicitly changes
  it.
- The management route registry includes the fork's external bundle, helper
  turn model, usage status, and managed local-runtime controls alongside the
  upstream routes.
- Managed external and local provider rows remain read-only through provider
  management, while ordinary rows receive upstream's empty-tool-output option
  validation.
- Helper-turn model settings accept canonical provider names and unique
  case-insensitive provider aliases, matching runtime routing while unknown
  namespaces still fail closed before an unattended helper turn.
- Direct ChatGPT routing distinguishes an unavailable account-model roster from
  a confirmed denial. The shipped Sol/Terra/Luna rows remain selectable while
  discovery is transiently unavailable, and the credential-owning upstream
  request remains the final authority. Confirmed omissions still fail locally;
  Pool accounts, exact account selectors, and Daybreak remain evidence-gated.
- Invalid config recovery keeps the last known user cost overlays instead of
  silently replacing them with defaults.
- External review and compaction retain their configured safe failure behavior.
- Credential-bearing atomic writers create an exclusive owner-only temporary
  file, verify its descriptor identity before writing, and retain the fork's
  one-shot Windows ACL timeout recovery for serialized owners.
- Grok cleanup preserves user TOML while removing only ownership-proven orphan
  rows and their semantic model references, including multiline values.
- Do not publish raw requests, private responses, tokens, cookies, headers,
  quota/account state, or machine-local configuration.

See `docs/local-integration/README.md` for the public local-runtime boundary and
`PROGRESS.md` for the current integration and verification checkpoint.
