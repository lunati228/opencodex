# Integration progress

## Current public checkpoint

- `origin/main` was already an ancestor of `ornith-setup`; the requested merge
  check required no merge commit.
- The managed Qwen source configuration now uses a 180K default context window,
  an explicit 128K row, and xhigh as the default agent reasoning effort.
- Non-GPT reasoning pickers use their model-declared ladders. GPT behavior was
  intentionally left unchanged.
- No Qwen request was run for this rewiring; a future live run requires explicit
  authorization.
- Public documentation has been reduced to behavior-level information. The
  ignored local runtime profile holds machine-specific verification and launch
  details.

## Focused verification

Only focused checks for the changed behavior and privacy safeguards are in
scope. The full repository suite is intentionally not a prerequisite for this
checkpoint.

## Publication boundary

Do not add local paths, artifact hashes or sizes, device placement, hardware
inventory, benchmark figures, captured logs, screenshots of live traffic,
account information, credentials, or recovery instructions to tracked notes.
