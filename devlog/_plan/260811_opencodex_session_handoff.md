# OpenCodex session handoff - reconciled 2026-08-21

Canonical current files:

- [fork contract](../../README-FORK.md)
- [progress](../../PROGRESS.md)
- [backlog](../../BACKLOG.md)
- [current state](../../docs/local-integration/CURRENT-STATE.md)
- [live plan](../../docs/local-integration/LIVE-TEST-PLAN.md)
- [ADR 0008](../../docs/adr/0008-kat-context-and-external-helper-turns.md)

## Repository checkpoint

| Item | Value |
|---|---|
| Repository | canonical OpenCodex worktree |
| Branch | `ornith-setup` |
| Deployed technical revision | `ad08f5048cdd745fa4fd6ce7bf1312afbcf7c5e4`; config correction `660b1eedc6710afd5d409d556cd48270e2e4f7e5`; merge `fcaed1172ad9ae46c86d1f178dd9ea1e5d5b50c1` integrates upstream/main `d9de89557c3bd154e5f1508125def7c8789ac8c5` (v2.22.0) |
| Push/status | Technical commits pushed to `origin/ornith-setup`; exactly two protected untracked paths |
| Identity | `lunati` |
| Activated proxy | companion PID `13644`, loopback `10100`; replaced PID `24636` after `3768 -> 24636` |
| Codex at activation | PID `21900`, unchanged; never stop Codex from this task |
| Active helper | `google-antigravity/gemini-3.7-flash` (wire `gemini-3.7-flash-tiered` with `thinkingLevel`), scope `external`, effort `high`, threshold `5` |
| Protected temp paths | ACL-blocked test fixtures (names withheld) |

## Helper decision

External review and compaction always use the configured Gemini helper. Native
review is native above 5% remaining and for unknown/malformed/stale quota, then
switches to Gemini at/below 5%. Native compaction never switches.

## Completed

- Gemini 3.7 picker entry `gemini-3.7-flash` routes to CCA wire
  `gemini-3.7-flash-tiered` with `thinkingLevel`; saved current suffixes and
  retired 3.6/3.5 aliases route safely; prototype defects fixed.
- Helper/quota policy and empty/truncated handoff safety are regression-tested.
- Reviewer CCA schema fix deployed and live-tested.
- Upstream universal max+ultra synthetic picker behavior adopted; pinned native
  GPT-5.6 metadata retained.
- Auto-compaction limits default to 85.5%.
- Live safe reviewer Git/read/move/junk-delete matrix passes on Gemini High.
- Quick Codex PID-generation recycle and guarded proxy reload pass.
- KAT 128K runtime, actual worker attribution, real Gemini compaction, and
  post-compaction KAT continuation are proven.
- A fresh true-low KAT one-line patch passes 3/3 with no fallback.
- KAT output-budget in source uses output 8,192 and reasoning 1,024/2,048/4,096.
- Final tests verified: reasoning effort 43/0 (283 assertions), Gemini batch
  153/0 (452), helper/compaction/router/quota/config/log 513 pass / 6 skip / 0 fail
  (2,010), catalog/harness 56/0 (507), test runner 1/0 (8), synthetic tier 4 pass /
  129 filtered / 0 (11), Cursor 2/0 (86), native GPT-5.6 control 1 pass / 183 filtered /
  0 (32); typecheck passed; privacy scan passed; git diff --check clean.
- ROOT-2 documented: `Environment.GetFolderPath(LocalApplicationData)` process
  USERPROFILE dependency (`codex-user-identity`: 5 pass / 1 fail / 22 assertions).
- `ocx config export` managed-projection correction `660b1eed` passed its 3/0
  regression, 220 pass / 6 skip / 0 fail wrapper batch, typecheck, and privacy.
- Streamed Responses access correction `ad08f504` passed its 23/0 regression,
  41/0 isolated access/warmup batch, typecheck, and privacy.
- Validated/ACL-verified config and existing pristine catalog backups preceded
  mutation; guarded reloads `3768 -> 24636 -> 13644` preserved Codex PID `21900`.
- Exact helper readback, no-tools Gemini 3.7 auto-review, and native GPT-5.6
  control passed with no fallback. KAT remained stopped.

## KAT classification

The retained quant/path/hash/placement are unchanged. The long parser task and
short-context control made no durable edit. Several turns consumed exactly the
old 4,096-token response cap; medium reasoning equaled that cap and high was
unrestricted. A direct low-budget call produced valid `apply_patch` in 80
tokens, and a fresh simple agent edited successfully.

Conclusion: no evidence supports replacing the quant or shrinking 128K. The
exact-token loop was output-budget starvation; complex KAT agent work remains
unaccepted. Deployed source uses output 8,192 with low/medium/high reasoning
1,024/2,048/4,096 and needs final live medium/high proof.

## Remaining gates

1. In a separately approved model-service window, run tiny KAT medium/high
   patch controls and verify actual attribution and normal idle release.
2. Keep native quota-boundary and 256K workstation evidence partial rather
   than forcing them during an active Codex task.
3. Review/commit Odysseus docs separately in its own repository.

No prompts, credentials, headers, cookies, raw quota, private logs, account
identity, model files, or unrelated work may enter commits or retained evidence.
