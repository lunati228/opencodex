# Integration backlog

## Qwen release gates

| ID | State | Required outcome |
| --- | --- | --- |
| QWEN-1 | Complete | The branch already contains the current `main` history. |
| QWEN-2 | Complete in source | Managed Qwen defaults to 192K, offers an explicit 128K row, and uses xhigh as its default agent effort. |
| QWEN-3 | Deferred | Do not start Qwen without explicit operator authorization. |
| QWEN-4 | Pending authorization | Run one bounded non-sensitive task and verify its terminal outcome and scoped durable edit. |

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
