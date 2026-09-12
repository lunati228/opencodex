# Integration backlog

## Narrow repair exception - 2026-09-11

The owner authorized V1, Gemini 3.8, Qwen readiness and startup/catalog repairs
and a whole-history merge through canonical v2.48.0. Further upstream merges
are paused at `9a27e86992d7a014e0aa92c046199b9fac148201`; no commit or push is
part of this work. See [the current freeze and repair record](CHATGPT-APP-FREEZES.md)
for exact scope, accepted gaps and undo instructions. Further freeze or destaging
work has stopped. This exception takes precedence over the historical notice below.

The explicitly authorized Gemini and managed Qwen model-health checks completed
through the proxy with their exact requested models. Qwen started on demand at
xhigh with the configured context; autostart remains off. This health check did
not perform the durable workspace edit required by QWEN-4 and does not resume
Harness/Odysseus work or the other unfinished release gates.

## Maintenance freeze - 2026-09-09

**All unfinished work below is paused until a later explicit owner instruction.**
Existing item states are retained as history; a pending authorization or
integration-validation entry does not permit execution during the freeze.
Harness-driven implementation, integration and validation remain paused.

Preserve Codex desktop **26.901.6511.0**, working bundled/cached CLI **0.153.4**,
and OpenCodex **2.42.0**, baseline commit
`d90f918cf6d6b2726c9d6b282707a862acf5b746`. No app/CLI/OpenCodex upgrades or
downgrades, dependency refreshes, catalog/routing/adapter/pricing changes, or
automatic updater changes are authorized except the owner's explicitly
authorized freeze implementation. Preserve the running processes and routing
without an app relaunch or PC restart.

This is a documentation pause, not technical update enforcement. Authorized
lifecycle-only freeze patches may change the working tree while preserving the
baseline versions. Read [the maintenance freeze policy](MAINTENANCE-FREEZE-2026-09-09.md)
before considering any backlog item or resumption.

## Qwen release gates

| ID | State | Required outcome |
| --- | --- | --- |
| QWEN-1 | Complete | The branch already contains the current `main` history. |
| QWEN-2 | Complete in source | Managed Qwen defaults to 180K, offers an explicit 128K row, and uses xhigh as its default agent effort. |
| QWEN-3 | Deferred | Do not start Qwen without explicit operator authorization. |
| QWEN-4 | Pending authorization | Run one bounded non-sensitive task and verify its terminal outcome and scoped durable edit. |

## Harness consumer lifecycle

| ID | State | Required outcome |
| --- | --- | --- |
| LEASE-1 | Complete in source | Authenticated v1 acquire, heartbeat, status, and idempotent release with owner-bound opaque tokens, 90-second expiry, and 30-second heartbeat. |
| LEASE-2 | Complete in source | Separate proxy ownership and model-use holds; preserve queued requests, five-minute idle release, manual-start exception, and busy companion retries. |
| LEASE-3 | Complete in source | Return only the verified numeric-loopback model descriptor, with optional `supportsVision` captured from awake affirmative `/props` metadata and projected as false otherwise; text readiness is unchanged. Refuse foreign or unverified backends and lifecycle mutations that would interrupt other consumers. |
| LEASE-4 | Adapter connected; live smoke passed; full acceptance pending | The Harness adapter implements exact-origin/path and redirect restrictions, with component checks for failure/expiry. One real direct local-adapter call passed loading, verified context/effort, normal completion and owner release. Long streams, multi-consumer/companion protection, measured idle unloading and desktop research remain unaccepted. |

The management contract is documented in `README-FORK.md`. Consumer leases do
not create a research inference route, cloud fallback, persistent consumer
identity, or authorization to start a live model during development checks.

The [migration audit](HARNESS-INTEGRATION-AUDIT.md) distinguishes committed
OpenCodex changes from earlier synthetic diagnostics and later maintenance work.
The old lease-API-unavailable blocker is superseded by the recorded post-reboot
adapter smoke. A plain response is not QWEN-4's scoped durable edit, so QWEN-4
remains open. No acceptance was rerun for the 2026-09-10 documentation update;
the maintenance freeze remains in effect.

## Privacy gate

Public material must contain only behavior-level configuration. The ignored
local runtime profile owns artifact verification, launch details, and all
machine-specific information. Do not add paths, hardware topology, measurements,
logs, account identifiers, credentials, or recovery layout to the repository.

## Out of scope

- Retired local-model research and benchmark campaigns.
- A second managed local-runtime slot.
- Reintroducing synthetic reasoning levels for models that do not declare them.
- Treating a privacy redaction as authorization to delete local operator data.
