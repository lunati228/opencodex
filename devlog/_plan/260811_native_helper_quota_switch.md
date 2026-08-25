# Native helper defaults with a 5%-remaining Gemini switch

**Decision:** implemented, regression-tested, and deployed, amended so every
external review and compaction uses the configured Gemini helper at all quota
levels. Canonical helper model is `google-antigravity/gemini-3.7-flash` (routing
to CCA wire `gemini-3.7-flash-tiered` with `thinkingLevel`).

## Routing table

| Remaining Codex quota | Native review | External review | Native compaction | External compaction |
|---|---|---|---|---|
| More than 5% | Native | Gemini | Native | Gemini |
| Exactly 5% or less | Gemini | Gemini | Native | Gemini |
| Unknown/windowless/malformed/stale | Native | Gemini | Native | Gemini |

The switch is pre-dispatch policy, not retry/fallback. Gemini failure, timeout,
malformed output, and explicit denial are terminal. Forced `high` effort and
helper attribution apply only when Gemini is actually selected.

## Quota semantics

- Provider values are percentage used.
- Exactly 95% used activates the low-quota mode; 94.999% does not.
- Use only the canonical OpenAI report.
- Take the maximum known utilization across five-hour, weekly, monthly, and
  custom windows.
- Non-OpenAI, missing, malformed, or windowless reports cannot activate it.
- A report is stale at exactly 30 minutes.
- Valid thresholds are integer 0-100; `null` clears through the API.
- Updates are atomic: one invalid field rejects the whole update.
- Each request freezes one cached privacy-safe snapshot and clock reading.
- A missing threshold retains legacy permanent-override behavior governed by
  `helperTurnScope`.

The configuration field is:

```json
{ "helperTurnCodexRemainingPercentThreshold": 5 }
```

## External alias

`opencodex-external-auto-review` remains stamped on external catalog rows at
all quota levels. It is a durable origin marker. Per request it resolves to the
configured Gemini helper; native rows remain unstamped. Catalog refresh timing
does not select the reviewer.

## Gemini 3.7 wire routing

The Gemini 3.7 picker entry `gemini-3.7-flash` routes to CCA wire
`gemini-3.7-flash-tiered` with `thinkingLevel`. Saved current suffixes
(`gemini-3.7-flash-high`, etc.) and retired 3.6/3.5 aliases route safely to
the tiered wire model. Prototype and inherited-property lookup defects are
fixed, and public signatures remain unchanged.

## Verification

- Exact quota boundaries, custom-window maximum, stale boundary, malformed and
  legacy cases are regression-tested.
- Native compaction remains native in every fixture.
- External review/compaction always resolve to Gemini.
- Live harmless review cases pass on Gemini High with no fallback.
- Reviewer schema errors and unavailable-model errors fail closed.
- Real KAT automatic compaction used Gemini High and continued on KAT.
- Final helper settings read back exactly after guarded activation. A fresh
  no-tools Gemini 3.7 auto-review and native GPT-5.6 control completed at HTTP
  200 with no fallback. Both controls were repeated through the supported
  streamed Responses access command after revision `ad08f504`; its isolated
  access/warmup batch passed 41/0. KAT medium/high was not run because the
  runtime was stopped.

See [ADR 0008](../../docs/adr/0008-kat-context-and-external-helper-turns.md)
and [PROGRESS.md](../../PROGRESS.md) for current evidence.
