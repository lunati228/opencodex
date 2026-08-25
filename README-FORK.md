# OpenCodex integration fork

This fork adds a privacy-conscious local-runtime integration while preserving
OpenCodex's public routing behavior.

## Public local-runtime contract

The managed Qwen profile has a 180K (184,320-token) default context window and
an explicit 128K (131,072-token) lower-memory row. Qwen agent work defaults to
xhigh reasoning; the picker exposes exactly low, medium, and xhigh. Saved
obsolete local reasoning values normalize only at the compatibility boundary.

Machine-specific launch configuration is loaded from an ignored local runtime
profile. Public source and documentation intentionally omit artifact paths,
hashes, sizes, device placement, hardware topology, capacity, measurements,
logs, screenshots, credentials, account data, and recovery layout.

The managed local listener remains loopback-only. A local Qwen run is never
implied by configuration changes and requires explicit operator authorization.

## Routing and safety

- Native GPT behavior remains unchanged.
- Non-GPT pickers reflect each model's declared reasoning ladder rather than a
  synthetic universal maximum.
- External review and compaction retain their configured safe failure behavior.
- Do not publish raw requests, private responses, tokens, cookies, headers,
  quota/account state, or machine-local configuration.

See `docs/local-integration/README.md` for the public boundary and `PROGRESS.md`
for the current implementation status.
