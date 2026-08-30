# OpenCodex integration fork

This fork adds a privacy-conscious managed local runtime, external review, and
automatic compaction while retaining OpenCodex's public routing behavior.

## Branch and history contract

`auto-compact-n-review` is the fork's integration branch. Its merge history
keeps both the fork tip and canonical `lidge-jun/opencodex:main` as parents; the
fork changes are not squashed, rebased, or copied into an unrelated history.
`ornith-setup` remains available as a rollback reference.

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
