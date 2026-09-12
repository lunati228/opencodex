# Local-integration public boundary

This directory contains a privacy-safe public summary of the optional local
runtime integration. It is intentionally not an operator runbook.

## Public contract

- The managed Qwen profile uses a 180K (184,320-token) default context window
  and exposes an explicit 128K (131,072-token) lower-memory row.
- Qwen agent work defaults to xhigh reasoning. Its picker exposes only low,
  medium, and xhigh.
- Model identity, artifact verification, launch arguments, device placement,
  local paths, measurements, and recovery data are loaded only from ignored
  machine-local configuration.
- Large local model files may use substantial host memory while loading; a
  machine-local profile may disable memory mapping when preserving available
  system RAM matters. This is an operational setting, not part of the public
  model identity or catalog contract.
- The local runtime is loopback-only and is not started without explicit
  operator authorization.
- First-request cold loading remains bounded, while a terminal supervisor
  failure returns a sanitized 503 on the next readiness poll rather than
  consuming the remainder of the load timeout.
- Managed provider rows are derived state. Provider-editor saves and startup
  migrations reconstruct them before adopting persisted configuration; the
  rows themselves remain absent from the persisted provider table.
- The `ocx:openai-chat:request` diagnostic describes request construction.
  Buffered sidecar output can delay visible text; it does not explain a
  socket-closed failure or establish that a request completed.

## Publication rule

Do not add workstation inventories, device names, capacity figures, filesystem
paths, hashes, process identifiers, logs, screenshots of live traffic, or raw
benchmark results here. Record public behavior and testable interfaces only.
