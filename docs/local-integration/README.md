# Local-integration public boundary

This directory contains a privacy-safe public summary of the optional local
runtime integration. It is intentionally not an operator runbook.

## Public contract

- The managed Qwen profile uses a 192K (196,608-token) default context window
  and exposes an explicit 128K (131,072-token) lower-memory row.
- Qwen agent work defaults to xhigh reasoning. Its picker exposes only low,
  medium, and xhigh.
- Model identity, artifact verification, launch arguments, device placement,
  local paths, measurements, and recovery data are loaded only from ignored
  machine-local configuration.
- The local runtime is loopback-only and is not started without explicit
  operator authorization.

## Publication rule

Do not add workstation inventories, device names, capacity figures, filesystem
paths, hashes, process identifiers, logs, screenshots of live traffic, or raw
benchmark results here. Record public behavior and testable interfaces only.
