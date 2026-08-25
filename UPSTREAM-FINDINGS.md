# Upstream v2.11.1 Windows findings

Date: 2026-08-09

Upstream revision: `121f1ad929dc6da3356c06f5192f2f97f7a5dde5` (`v2.11.1`)

These defects were reproduced on an untouched detached upstream worktree under
the same Windows account. They are not fixed in this fork. The intended path is
an upstream report/fix followed by a later merge.

## Verification boundary

- Fork matrix: all 647 root test files ran in separate Bun processes with zero
  process timeouts.
- Effective fork result after the xAI test-harness correction: 10,225 passed,
  118 failed, and 16 skipped; 32 files still fail.
- Upstream reproduction: the same 32 files fail on untouched `v2.11.1`.
- The fork-only xAI failure did not reproduce upstream. It was fixed locally by
  awaiting asynchronous credential seeding and now passes 4/4.

## Reproduced findings

| Area | Affected tests | Finding | Workaround / proper upstream repair |
|---|---|---|---|
| Bun executable lookup | `ci-workflows`, `management-integration-routes`, `model-metadata-sync`, `translator-budget` | Child processes spawn bare `bun`, but the repository-local Bun executable is not guaranteed to be on `PATH`. | Local workaround: prepend `node_modules/.bin` to `PATH`. Proper repair: spawn the known runtime executable or pass its absolute path. |
| Effective Windows account and home | `cli-restore-back`, `codex-catalog-restore`, `codex-catalog-sync-hardening`, `codex-composed-acceptance`, `codex-inject-integration`, `codex-inject-write-lock`, `codex-journal`, `codex-sync-api`, `codex-transition-state`, `codex-transition-state-race`, `codex-user-identity`, `loopback-listener-integration` | Child fixtures mutate `HOME`/`USERPROFILE`; the Windows effective-account lookup can then return no usable profile, so Codex paths, locks, and journals point at the wrong place or fail closed. | No safe production workaround. Proper repair: derive the effective token SID, then resolve that SID through trusted Windows profile/registry APIs with a bounded cache and timeout. |
| Windows path conversion | `cli-account`, `codex-history-reachability` | A file URL pathname and slash-delimited inventory checks are compared as if Windows used POSIX paths. | Use `fileURLToPath` and normalize separators before comparison. |
| Multi-process lock harnesses and deadlines | `codex-convergence-account-selectors`, `codex-history-lock`, `codex-history-worker`, `codex-retained-root-serialization`, `codex-transition-state-race`, `codex-write-lock` | Several child readiness markers are not durably published before a busy wait, or a five-second budget is shorter than normal Windows process startup. | Run files separately to avoid suite contamination. Proper repair: publish readiness synchronously/await it, drain children, and use a measured Windows deadline. |
| POSIX-only permission and symlink assumptions | `codex-write-lock`, `native-main-auth-temp`, `native-main-claim`, `responses-state`, `test-home-guard`, `update-npm-cache-preflight` | Tests require Unix mode-bit behavior, `/dev/null`, or unrestricted symbolic-link creation. Standard Windows tokens return `EPERM`, and NTFS does not expose POSIX `0600` semantics in the asserted form. | Developer Mode/admin may unblock symlink cases. Proper repair: use Windows junctions where valid, skip unsupported symlink cases explicitly, and verify ACL policy instead of POSIX mode bits. |
| Resource/ACL cleanup | `codex-config-generation`, `server-rate-limit-retry-e2e` | Failure-path fixtures leave an empty-DACL file or a live handle, so cleanup ends with `EACCES`/`EBUSY`. | Manual cleanup may require the file owner to restore one ACL entry. Proper repair: release handles and restore fixture ACLs in `finally`. |
| Codex auth concurrent generation | `codex-auth-api` | Nine pool-quota/refresh cases lose or repeat completion state across concurrent generations. | No reliable workaround beyond isolated reruns. Proper repair belongs upstream: retain completed generation results long enough for compatible joiners and invalidate them by generation epoch. |
| Fixture isolation and Windows exit semantics | `project-config-warnings`, `codex-composed-acceptance` | A project-config fixture can see the real global config, and Windows process termination does not match the asserted POSIX exit status. | Isolate the global config root explicitly and assert platform-correct process termination. |

The failures remain visible in the test result. They were not skipped, weakened,
or converted into fork patches.
