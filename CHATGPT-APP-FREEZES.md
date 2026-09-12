# Codex / ChatGPT freeze and OpenCodex repair

Status recorded on 2026-09-12. The owner accepted the partial application freeze
and stopped further updater, Store-policy and staged-package work. Do not resume
those operations from an older checklist. Native provider quota cannot be
frozen by local configuration.

## Authorized source milestone

The repair integrates the **whole canonical v2.48.0 milestone**, commit
[`9a27e86992d7a014e0aa92c046199b9fac148201`](https://github.com/lidge-jun/opencodex/commit/9a27e86992d7a014e0aa92c046199b9fac148201),
with the fork's changes retained. This is a merge of all history to that point,
not selected commits. That milestone includes relevant Codex CLI shim, catalog,
delegation and Windows fixes and retains the existing Bun 1.4.0 requirement and
dependency lockfiles. Later milestones change the Bun requirement and are
outside this repair's dependency constraints.

**Freeze subsequent upstream merging at this boundary.** Another upstream merge
requires a new explicit owner instruction. The source-checkout updater's existing
refusal remains in place; this policy does not technically disable manual Git
commands. The integration was initially prepared without a commit or push.
The owner subsequently authorized completing that merge commit and committing
the managed-provider repair separately. No push is authorized. The operator
rebooted afterward; earlier observations of the running proxy are historical.
Saving source or making these commits does not restart the proxy.

The narrow maintenance exception covers effective V1, exact Gemini 3.8 routing,
managed Qwen readiness, startup/catalog persistence, their tests and these
records. It also permits correcting stale CLI selection metadata to the already
running 0.153.4 executable. It does not permit app or CLI replacement, dependency
installation, credentials changes, an app/CLI/proxy restart, or activation of an
update. Harness/Odysseus implementation and OpenCode sign-in remain deferred.

## Applied controls and accepted gaps

The update-control evidence below is the last verified September 9 checkpoint,
not a new inspection or a claim that saved settings changed a loaded process.
Desktop 26.901.6511.0 and its active CLI 0.153.4 were separately rechecked during
the repair without replacing or stopping either executable.

| Control | Status and limit | Reversible undo, only when separately requested |
| --- | --- | --- |
| WinGet installed-package Blocking pin for `OpenAI.Codex_2p2nqsd0c76g0` | Applied. It is not a Store exclusion. | Run the exact pin-removal command below, then verify the pin list. |
| Machine Codex requirements: `[features]` / `in_app_updates = false` | Applied in the Codex requirements file under ProgramData. | Remove that newly created file only if it still contains exactly those two lines; otherwise review and remove only the added key. |
| Owner user environment: `CODEX_SPARKLE_ENABLED=false` | Saved for future launches. The updater already loaded in the app was enabled at launch. | In the intended owner's context, verify the current User value is exactly `false`, then remove only that User value using the command below. |
| CLI 0.153.4 recovery copy | Applied; hash-identical and unselected. It does not pin all executable discovery paths. | No runtime undo is needed. Delete only the recorded recovery copy after matching its recorded hash. |
| Source-checkout automatic updater | Already refuses source self-update; retained by the merge. | No new updater-control change to undo. Manual upstream merging remains subject to this policy. |
| Startup `--keep-proxy-running` and lifecycle fix | Saved. The old running companion has not adopted the saved launcher or source changes. | Remove only that argument and reverse the documented lifecycle hunks after checking for later edits. Do not stop a current process as part of the reversal. |
| Staged desktop 26.903.8094.0 | Incomplete: still present; further removal was stopped by the owner. | No completed removal to undo; do not replay old removal procedures. |
| Store `DoNotUpdate` | Last value was 0; no Store policy was applied. Deferred. | No change to undo. |
| Existing companion handoff | Incomplete: no live keepalive handoff was performed. | No handoff to undo. |

The final approved pending-removal inspection was **2026-09-09 20:50:24 UTC**:
all four pending-removal flags were false and original files were untouched.
This is historical evidence. No further deployment or freeze work is authorized.

Exact WinGet undo:

```powershell
winget pin remove 'OpenAI.Codex_2p2nqsd0c76g0' --installed --source msstore --exact --disable-interactivity
winget pin list --source msstore --disable-interactivity
```

Exact owner User-environment undo, after the value check above:

```powershell
[Environment]::SetEnvironmentVariable('CODEX_SPARKLE_ENABLED', $null, 'User')
[Environment]::GetEnvironmentVariable('CODEX_SPARKLE_ENABLED', 'User')
```

Exact requirements-file undo, only if the complete file is still the newly
created two-line policy (run in an authorized administrator context):

```powershell
$requirementsPath = Join-Path $env:ProgramData 'OpenAI/Codex/requirements.toml'
$requirementsText = [IO.File]::ReadAllText($requirementsPath).Replace("`r`n", "`n")
if ($requirementsText -cne "[features]`nin_app_updates = false`n") {
  throw 'Requirements changed; review the added key instead of deleting the file.'
}
Remove-Item -LiteralPath $requirementsPath
```

Exact saved-launcher undo, in the intended owner's environment:

```powershell
$launcherPath = Join-Path $env:USERPROFILE '.opencodex/opencodex-companion-launcher.vbs'
$launcherText = [IO.File]::ReadAllText($launcherPath)
if ([regex]::Matches($launcherText, ' --keep-proxy-running').Count -ne 1) {
  throw 'Launcher changed; inspect it before editing.'
}
[IO.File]::WriteAllText($launcherPath, $launcherText.Replace(' --keep-proxy-running', ''), [Text.UTF8Encoding]::new($false))
```

To undo the earlier lifecycle patch only, use its retained private receipt:
`git apply --reverse --check <private-workspace>/work/freeze-03/companion-keep-proxy.patch`,
then the same command without `--check` only if the check succeeds and its diff
contains just that patch. Later repair hunks may require a reviewed manual
reversal. Never restore an entire source file over unrelated edits. The recovery
copy's exact path and hash likewise belong in the private receipt, not this repo.

Do not infer that an owner setting is absent from a sandbox account's empty
profile. None of these undo instructions is an instruction to execute it now.

## Routing and startup contract

- Saved `multiAgentMode` is `v1`; the global `multi_agent_v2` override is off.
  Native and external catalog rows select V1. Already loaded tasks and MCP tool
  definitions retain their own process/session state.
- Native Astra retains its provider, model, effort and service tier.
- The Gemini picker route is `google-antigravity/gemini-3.8-flash` at `high`.
  The Antigravity MCP shortcut is `gemini-3.8-flash-high` at `high`. Neither may
  substitute or relabel 3.7. A loaded old MCP shortcut must use the generic tool
  with the explicit 3.8 identifier until an ordinary future tool reload.
- Managed Qwen uses `qwen-local/huihui-qwen3.8-27b-abliterated-q6-k-l` at `xhigh`.
  Its runtime starts on demand. Proxy readiness and catalog publication do not
  depend on loading the local model.
- Keep-running companion mode starts the lightweight proxy before seeing an app
  process. An intentional companion shutdown preserves the endpoint and catalog;
  the CLI exit handler honors the same decision. Undeclared external selectors
  reaching the proxy fail instead of using the native ChatGPT default.

The repair used the existing catalog-only management path to save V1 without a
process restart. Cache publication was verified immediately, but the already
running app later rewrote its older native-only cache. That observation is not a
successful live picker acceptance. A fresh first-opening picker and tool surface
acceptance
must be checked at an ordinary future launch; do not restart this working app to
force that check. Before then, source tests establish the startup ordering and
routing contract, while saved files establish future process configuration.

The original [maintenance freeze](MAINTENANCE-FREEZE-2026-09-09.md) and
[backlog](BACKLOG.md) remain historical context. This explicit exception takes
precedence only within the scope above.
