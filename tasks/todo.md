# Upstream v2.11.1 merge and reliability recovery checklist

- [x] Read repository instructions and current fork documentation.
- [x] Confirm the G: worktree is clean and identify remotes/branches.
- [x] Validate the installed Playwright browser fallback without installing anything.
- [x] Fetch official upstream and pin `upstream/main` at `121f1ad92` (`v2.11.1`).
- [ ] Audit upstream releases, dependencies, install hooks, auth/network, ACL, and catalog changes.
- [ ] Create the isolated integration branch and merge all of `upstream/main`.
- [ ] Resolve every conflict while preserving fork invariants.
- [ ] Run conflict-focused regression tests.
- [ ] Reproduce and localize the auto-approval review failure boundary.
- [ ] Add regression tests for any remaining reproducible defect before fixing it.
- [ ] Implement minimal reliability fixes or record a supported workaround/external blocker.
- [ ] Triage active fork backlog items against the merged code.
- [ ] Run typecheck, full tests, GUI lint/build, privacy scan, and diff checks.
- [ ] Obtain an independent read-only diff/test review and resolve required findings.
- [ ] Commit as `lunati`.
- [ ] Fast-forward branch `ornith-setup` to the verified result.
- [ ] Confirm final G: status, ancestry, and no push.
