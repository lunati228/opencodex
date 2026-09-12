# Maintenance freeze - 2026-09-09

## Narrow owner exception - 2026-09-11

The owner subsequently authorized effective V1, exact Gemini 3.8, managed Qwen
readiness and first-opening catalog repairs, plus a whole-history merge through
canonical v2.48.0 (`9a27e86992d7a014e0aa92c046199b9fac148201`). Further upstream
merges are paused there. No commit, push, dependency installation, app/CLI update
or running-process restart is part of this exception. Minimal provider health
inference and correction of stale CLI selection to the already active 0.153.4
executable are authorized. Harness/Odysseus work and OpenCode sign-in stay paused.

Further freeze, staged-update removal and updater-control work has stopped.
See [CHATGPT-APP-FREEZES.md](CHATGPT-APP-FREEZES.md) for the applied controls,
accepted gaps, saved-versus-loaded distinction and reversible undo instructions.
This exception supersedes conflicting clauses below only within its scope.

## Original policy and baseline

**Status: active. Resumption requires a later explicit owner instruction.**

This policy preserves the current working Codex desktop, its CLI and OpenCodex.
It takes precedence over instructions to continue unfinished maintenance in
[README-FORK.md](README-FORK.md) and [BACKLOG.md](BACKLOG.md). Existing backlog
states and technical descriptions remain intact as reference material.

## Baseline to preserve

| Component | Baseline | Evidence and limits |
| --- | --- | --- |
| Codex desktop | 26.901.6511.0 | Running executable belongs to this package; registered package metadata agrees. |
| Working bundled/cached CLI | 0.153.4 | Active executable hash matches the earlier version-verified baseline and this desktop's bundled CLI. |
| OpenCodex | 2.42.0 | Repository package version; source baseline is commit `d90f918cf6d6b2726c9d6b282707a862acf5b746`. |

The versions were revalidated when this notice was prepared on 2026-09-09.
Use fresh process, executable and source evidence if an actual discrepancy is
found; record it and preserve the functioning runtime. A discrepancy does not
authorize replacing a running component to make it match this table.

The earlier investigation recorded a stale selected CLI entry naming 0.153.3
at an unavailable path, while the desktop was already running 0.153.4. This
document does not repair that selection or claim that every future launch path
is pinned. Any separately authorized selection fix needs its own evidence.

The baseline commit identifies the starting source. These documentation edits
and authorized lifecycle-only freeze patches may make the working tree differ
from it. Do not infer a clean tree, an unchanged loaded runtime, fixed
dependencies, or a restorable installation from the commit or version alone.

## Work paused by the owner

- App, CLI and OpenCodex upgrades, downgrades, upstream merges and other source
  refreshes, including changing the selected executable to another version.
- Dependency installation or refresh, lockfile regeneration and package refreshes.
- Model catalog, routing, adapter or pricing changes, including automatic catalog
  refreshes and repair attempts motivated by the freeze investigation.
- Harness-driven patches, integration, validation and backlog execution.
- Automatic updater changes, except the specifically authorized freeze work below.

The sole current exception is the owner's explicitly authorized 2026-09-09
freeze implementation: narrowly scoped update prevention, safe pending-update
cancellation, preservation of the current CLI, lifecycle work to keep OpenCodex
alive on app exit, and the documentation pause. That authorization supersedes
the earlier planning-only phase for those tasks. It does not authorize normal
maintenance or expand any worker's assigned file ownership.

## No-interruption boundary

Preserve the running desktop, CLI and proxy and their model routing. No app
relaunch, PC restart, process kill, forced package application shutdown or
`/api/stop` call is authorized. Do not run live model inference, install or
replace software, change authentication/accounts, or disable unrelated Windows,
security or application updates or broad network access.

If a freeze step cannot meet this boundary, leave that step unapplied, retain
safe independent work and report a concrete procedure plus the limitation.
Keeping inference available takes priority over finishing a risky freeze step.
Do not exit the app merely to test proxy survival during this preservation work.

## Policy and technical enforcement are separate

This document and its linked notices change documentation only. They do not
disable an updater, cancel a staged package, pin CLI discovery, change a launcher,
prevent an automatic catalog refresh or make a proxy survive app exit.

The freeze coordinator must separately record each technical action as applied,
not applied or blocked, with before/after evidence and an undo procedure. Record
whether it affects the current process or only a future launch. A file edit alone
is not evidence that an already-running process adopted the setting.

Keep process identities, local paths, configuration fingerprints and other
machine-specific evidence in the private operational report, outside these
repository documents. Do not publish credentials, account identifiers, private
prompts, raw requests or responses, personal names or email addresses.

## Resumption and documentation undo

A later explicit owner instruction must identify the work to resume. A completed
freeze, an elapsed date, a new upstream release, a passing test or an old backlog
entry does not resume maintenance. Revalidate the running versions and the actual
technical controls before planning any authorized change.

Once the owner authorizes ending this policy, remove only the sections titled
`Maintenance freeze - 2026-09-09` from the README and backlog, then remove or mark
this policy superseded. Preserve all pre-existing sections and unrelated edits.
Do not reset the checkout. Removing documentation does not undo technical update
controls or lifecycle changes; use the separately recorded, owner-authorized
undo procedure for each of those controls.
