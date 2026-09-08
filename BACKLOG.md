# Integration backlog

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
| LEASE-4 | Integration validation pending | Connect the Harness direct local adapter, deny redirects, restrict inference to the verified origin and exact chat-completions path, and validate client failure/expiry behavior. |

The management contract is documented in `README-FORK.md`. Consumer leases do
not create a research inference route, cloud fallback, persistent consumer
identity, or authorization to start a live model during development checks.

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
