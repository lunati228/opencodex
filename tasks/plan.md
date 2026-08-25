# Upstream v2.11.1 merge and reliability recovery plan

## Objective

Merge the complete current `upstream/main` history through `121f1ad92`
(`v2.11.1`) into `ornith-setup`, preserve the fork's local-model and helper-turn
contracts, and fix reproducible local reliability defects without weakening the
approval or credential boundaries.

## Acceptance criteria

- The resulting fork contains `upstream/main` as an ancestor.
- Existing fork-only commits remain reachable and authored as
  `lunati`.
- Native Codex review/compaction remains native; routed review/compaction still
  uses the configured external helper policy.
- ACL or reviewer infrastructure failures remain fail-closed, but a stalled
  response-state write cannot block proxy health or poison unrelated writes.
- No credential, provider secret, private log, or live config is added to Git.
- Focused regressions, typecheck, privacy scan, and the full project test command
  pass, or every environment-only exception is reproduced and documented.

## Ordered work

1. Preserve the clean baseline and fetch the official upstream remote.
2. Audit release, dependency, install-hook, authentication, network, Windows
   ACL, and catalog changes from the old merge base through `v2.11.1`.
3. Merge `upstream/main` on an isolated branch and resolve conflicts by invariant,
   not by choosing an entire side.
4. Run focused tests for every conflict-heavy subsystem before broader tests.
5. Reproduce the approval-review failure boundary with safe probes; distinguish
   Codex approval review from OpenCodex routed auto-review.
6. Adopt or adapt upstream's principled ACL fixes. Add a failing regression first
   for any remaining fork-specific defect, then implement the minimal fix.
7. Triage the fork's active backlog and current upstream issues into fixed,
   workaround, external blocker, deferred hardware proof, or still reproducible.
8. Run the complete verification matrix and an independent diff review.
9. Commit locally as `lunati`, transfer the verified branch to the canonical
   worktree, and fast-forward `ornith-setup`. Do not push.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 2,384-commit upstream gap | Large conflict and regression surface | Isolated clone, exact merge-base, focused conflict tests, full suite |
| ACL code diverged on both sides | Credential/state loss or proxy stalls | Preserve exact-DACL fork contract; port upstream async behavior with regressions |
| Catalog/routing conflicts | Native or routed helper behavior changes silently | Assert native/external policy separately and inspect generated rows |
| Live config contains secrets | Disclosure through logs or Git | Inspect only allowlisted non-secret fields; run privacy and staged-secret scans |
| External provider outage | False local-fix work | Directly separate provider capacity from proxy behavior; document workaround |
| Approval reviewer outage | Work blocked or unsafe bypass temptation | Keep denial on uncertainty; isolate reviewer health from mutable response-state paths |

## Checkpoints

- After merge: no unresolved markers; `upstream/main` is an ancestor.
- After conflict repair: focused tests for ACL, config, catalog, helper turns,
  routing, lifecycle, GUI, and provider adapters pass.
- Before commit: typecheck, test, GUI lint/build, privacy scan, and diff review.
- Before G: handoff: independent reviewer verdict is `accept` or all required
  findings are resolved.

## Non-goals

- No provider login, OAuth consent, key inspection, package installation, model
  download, driver change, deployment, push, or broad artifact cleanup.
- No weakening of fail-closed approval or credential behavior.
