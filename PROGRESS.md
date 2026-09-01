# Integration progress

## Current public checkpoint

- `auto-compact-n-review` integrates the fork tip with canonical
  `lidge-jun/opencodex:main` through a history-preserving two-parent merge.
- `ornith-setup` is retained as a rollback branch. It is not scheduled for
  deletion as part of this integration.
- The managed Qwen source configuration remains at a 180K default context
  window, with an explicit 128K row and xhigh as the default agent effort.
- Ordinary routed models retain upstream's synthetic `max` and `ultra` picker
  tiers for agent validation. Provider adapters clamp those choices to each
  model's real highest wire effort; the managed Qwen ladder remains exact.
- No Qwen request was run during this integration. A future live run requires
  explicit operator authorization.
- Direct ChatGPT routing now distinguishes transient or malformed model-roster
  discovery from a confirmed account denial. Sol/Terra/Luna remain present in
  the Direct bare catalog; Pool, exact account selectors, and Daybreak retain
  confirmed-evidence requirements.
- Managed Qwen on-demand startup now distinguishes a slow load from a terminal
  supervisor failure. Terminal failures return a sanitized 503 after the next
  readiness poll instead of holding the Codex turn until the load deadline.

## Merge reconciliation introduced here

- Combined upstream management routing with the fork's external bundle, helper
  turn model, usage status, and managed local-runtime endpoints.
- Applied upstream blocked-model redirects without bypassing the fork's managed
  external-provider collision checks or managed-local readiness gate.
- Combined route-aware shadow-call self-target prevention with helper-turn quota
  routing. Real reroutes preserve configured effort; helper policy remains the
  only merge-side override.
- Kept managed provider projections read-only while adding upstream validation
  for the per-provider empty-tool-output annotation.
- Reconciled helper-turn target validation with upstream provider-alias routing:
  canonical names and unique case-insensitive aliases are accepted, while
  unknown or ambiguous namespaces still fail closed.
- Adopted exclusive owner-only atomic temp descriptors and identity checks while
  retaining the serialized one-shot Windows ACL timeout recovery.
- Adopted the expanded Grok orphan/reference cleanup and retained the hardened
  secret publisher. Multiline semantic references are handled without treating
  escaped user values as owned aliases.
- Kept Claude Desktop foreign profile keys while fingerprinting only routing
  shape, so credentials do not enter drift metadata.
- Kept the Windows test-runner timeout while integrating upstream changed-mode
  merge-base selection and argument rewriting.
- Preserved last-known user model-cost overlays when a broken config falls back
  to defaults.
- Reconciled current provider catalog, pricing, native entitlement, journal,
  temporary-state cleanup, and Windows path expectations without weakening
  production authentication or safety checks.
- Made the package-integrity filesystem test deterministic on coarse-timestamp
  Windows or virtual volumes, without changing the production integrity guard.
- Made two real-server WebSocket tests register their terminal listeners before
  sending and use the repository's established Windows parallel-load watchdog.
  Production request and WebSocket timeouts are unchanged.
- Replaced a timing guess in the storage-policy PUT race test with a test-only
  worker snapshot signal. Production cleanup behavior is unchanged.
- Split Direct account-model admission into confirmed grant, confirmed denial,
  and unconfirmed discovery. Only an unconfirmed shipped GPT-5.6 Direct case
  reaches the canonical upstream request; Daybreak, Pool, and exact-account
  selection remain fail-closed, and no credential material is logged or
  persisted by the change.

## Verification checkpoint

### Managed Qwen terminal startup regression

- The RED regression used the real supervisor harness to reproduce both a
  foreign listener and a failed readiness check. Before the repair, both paths
  consumed the full fake timeout and returned only `timeout`.
- After the repair, the focused on-demand, supervisor, profile, production
  selection, and private-profile slice completed with 61 passed and 0 failed.
- The adjacent helper-turn and local-runtime management slice completed with
  55 passed and 0 failed. The complete compaction-routing suite, which imports
  the changed Responses request core, completed with 50 passed and 0 failed.
- The core/Lab import-boundary guard completed with 17 passed and 0 failed.
- The repository-wide wrapper completed once in 921 seconds with exit 1. Its
  parallel lane reported 147 failures and 70 skips; the failures surfaced in
  unchanged baseline/environment tests, while all six serial isolation lanes
  passed. This is recorded as a non-green full-suite result, not as a pass.
- Typecheck reaches only the same three inherited `RequestInit.timeout`
  diagnostics produced by the clean integration baseline; no changed file
  produces a diagnostic.
- No local model, proxy lifecycle command, loopback request, or live runtime
  probe was used for this repair.

### GPT-5.6 Direct entitlement regression

- The network-free RED case reproduced the defect through the real Direct
  resolver: a mocked unavailable roster was mislabeled as the same local 401 as
  a confirmed omission. Its valid-200 omission control remained a denial.
- A second RED case proved that unconfirmed discovery removed the shipped Sol
  row from the Direct picker projection.
- After the repair, the three focused entitlement, auth-context, and native-row
  suites completed with 127 passed, 0 failed, and 510 assertions.
- The complete discovery suite passed with 12 tests and 122 assertions,
  including the real `/v1/models` shape: unconfirmed Direct discovery retains
  the three shipped bare rows while omitting Daybreak.
- The complete convergence/account-selector suite passed with 25 tests and 305
  assertions, confirming that the same state emits no GPT-5.6 account-selector
  rows and no bare Daybreak row.
- The repository privacy scan passed after the implementation and documentation
  updates.
- Import-graph changed-mode was not a usable scoped gate in this inherited
  worktree: its merge base selected 830 of 1,017 test files, then the existing
  dependency tree failed resolution before meaningful coverage. No full-suite
  result is claimed; the deterministic focused suites are the recorded gate.
- Typecheck reached only three unchanged `RequestInit.timeout` diagnostics in
  server transport files. The worktree has Bun 1.3.14 types while the lockfile
  expects 1.4.0; the clean integration checkout produces the identical three
  diagnostics, and no changed file produced one.
- The documentation site built successfully from the isolated sources by
  reusing the clean checkout's existing same-branch dependency tree: 401 pages,
  the Pagefind index, and the sitemap completed without an install or lockfile
  change. The temporary dependency junction was removed after the build.
- The same integration branch later recovered after a process restart without
  receiving this isolated, uncommitted patch. That is treated as evidence that
  the trigger includes transient runtime, upstream, cache, or authentication
  state; it does not remove the deterministic unknown-versus-denied flaw.
- No live proxy request, lifecycle operation, credential read, or configuration
  mutation was used to validate this repair.

### Latest conflict-area checks

- Typecheck passed on the merged tree.
- The six directly conflicted test files completed with 164 passed, 2
  platform-specific skips, and 0 failures.
- Router, helper-turn, compaction, shadow-call, local-runtime, and provider
  management overlap checks completed with 249 passed and 0 failures.
- The Grok/atomic focused batch initially completed 282 checks and exposed two
  overlap mismatches. Both were repaired; the failing cases and the adjacent
  escaped-multiline guard passed focused reruns.
- The two exclusive-private-temp integration checks passed.
- The independent conflict review found one helper-target/provider-alias
  composition mismatch. Its regression failed with the original 422 response,
  then the helper, provider-alias, and atomic-classification checks completed
  with 53 passed and 0 failures after the repair.
- These checks intentionally cover the merge overlaps only. A completed
  repository-wide gate is not claimed.

### Earlier integration baseline

- Catalog reconciliation: 289 focused tests passed.
- Package-integrity portability case: 30 passes across three repeated runs.
- WebSocket auth-refresh cases: six checks passed across three repeated runs.
- Managed auto-compaction and test-runner checks: 21 passed.
- Focused config, catalog, and local-runtime groups: 578 passed, 6 skipped.
- Focused server/runtime groups: 516 passed; Windows process groups: 64 passed.
- GUI: 1,092 tests passed across 181 files; lint, i18n, and build passed.
- Typecheck, privacy scan, and package preparation passed.
- The deterministic storage-policy PUT race check passed in isolation and under
  the heavy parallel runner. At operator direction, the repository-wide run was
  stopped after the overlapping integration areas passed.

## Publication boundary

Do not add local paths, artifact hashes or sizes, device placement, hardware
inventory, benchmark figures, captured logs, screenshots of live traffic,
account information, credentials, or recovery instructions to tracked notes.
