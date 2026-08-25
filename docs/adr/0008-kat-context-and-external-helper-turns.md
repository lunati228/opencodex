# ADR 0008: Fixed managed-local context rows and external helper turns

- Status: Accepted
- Date: 2026-07-29
- Owners: OpenCodex fork maintainers
- Current implementation status: helper/quota policy and Gemini 3.7 wire
  routing (`gemini-3.7-flash` -> CCA wire `gemini-3.7-flash-tiered` with
  `thinkingLevel`, routing saved suffixes and retired 3.6/3.5 aliases safely) are
  implemented and regression-tested. The active managed-local contract exposes
  Qwen at fixed 128K and 180K rows, uses 180K by default, and publishes exactly
  low, medium, and xhigh reasoning with xhigh as the default. Machine-specific
  runtime evidence and launch configuration are intentionally untracked.

## Context

Codex assigns one `context_window` and one `auto_compact_token_limit` to each
catalog model. A service-tier request option cannot change those catalog
values. Representing managed-local context sizes as service tiers therefore lets Codex
budget against one window while `llama.cpp` is running another.

This was rechecked after the first live run when the user asked whether the six
rows could move back under Speed. Upstream still models Speed as a
`service_tier` request choice, while each model entry owns exactly one context
window and one auto-compaction limit. Upstream issue
[openai/codex#13653](https://github.com/openai/codex/issues/13653) proposes a
separate context-preset feature precisely because this is not currently a
native Speed capability. Therefore the fork will not overload Speed or patch
Codex itself to simulate it.

The accepted managed Qwen runtime profile is deliberately narrower than any
model-card ceiling: the public contract is 184,320 tokens, with a 131,072-token
lower-memory row. Artifact identity, local paths, hardware placement, and
measurements belong only in the ignored private profile.

Codex catalog entries expose both `auto_compact_token_limit` and
`auto_review_model_override`, and Codex loads a custom model catalog on
startup. Sources: [Codex catalog protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs),
[Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).

Running the managed local model as its own automatic reviewer or compactor can
require a second concurrent local turn exactly when the original turn is consuming
the one available server slot. The fork also needs native Codex conversations
to retain native Codex helper behavior.

GLM 5.2's model page advertises a model-native 1M context, but the managed
NVIDIA hosted route enforces a smaller effective request cap. That route must
publish the endpoint it can actually serve; otherwise Codex either waits too
long to compact or receives the generic 128K fallback. This is provider-route
metadata, not a global statement about GLM.

## Decision

1. Publish the managed local model as real catalog rows generated from one
   canonical fixed table. Amended 2026-08-25 to the accepted Qwen profile:

   | Picker choice | Context | Auto-compact trigger |
   |---|---:|---:|
   | 128K | 131,072 | 112,066 |
   | 180K | 184,320 | 157,593 |

   The row COUNT is a product decision and may change again. What may not
   change is the mechanism: one row per real window, never one row whose
   allocation moves underneath it.

2. Keep the bare managed-Qwen model id as the accepted 180K default. Give the
   128K row a bracketed suffix and strip that suffix before sending the model id
   to `llama.cpp`.
3. Retire the former 192K and 256K managed-local rows. Migrate saved 196,608-
   and 262,144-token values to 184,320; migrate older smaller retired rows to
   131,072. This compatibility conversion is explicit and does not silently
   advertise a retired allocation.
4. Amended 2026-08-21: route automatic review and automatic compaction for every
   external conversation to the configured `google-antigravity` Gemini helper
   at every Codex quota level. The canonical helper model is
   `google-antigravity/gemini-3.7-flash` (mapping to CCA wire
   `gemini-3.7-flash-tiered` with `thinkingLevel`). Saved current suffixes and
   retired 3.6/3.5 aliases route safely to the tiered wire. Direct `google` and
   unrelated aggregator identities remain unchanged. Keep the external review
   alias `opencodex-external-auto-review` as a stable source marker; catalog
   timing or quota decoration must not choose a helper. This also keeps the
   one-slot managed-local runtime out of its own compaction request.
5. While a fresh OpenAI/Codex provider-quota report has more than 5% remaining,
   native review and native compaction stay native. At 5% or less (95% used or
   above), Gemini also reviews native conversations. Native GPT/Codex
   compaction is never redirected. Unknown, windowless, malformed, or
   30-minute-stale quota keeps native review native; external review and
   compaction still use Gemini.
6. Use the Google account authenticated through OpenCodex's
   `google-antigravity` provider for helper turns. Do not use or import the
   separate AGY CLI/MCP account.
7. Show two non-routable picker readouts: `AGY Usage` for the OpenCodex login
   and `MCP Usage` for the separate CLI/MCP login. Display remaining percentage
   and preserve explicit `5h` and `weekly` labels. If a source exposes only one
   unlabeled family pool, call it `current`; never infer a window from reset
   time.
8. Keep Gemini's effort name as `high`. Do not rename it to `max`. Apply the
   effort override only when the Gemini helper is actually selected. This
   decision does not alter direct Google or aggregator model identities.
9. Keep managed-local rows separate unless upstream Codex gains a real context
   preset surface that carries both `context_window` and
   `auto_compact_token_limit`. Service-tier interception alone is not an
   acceptable replacement.
10. Treat the routed helper's visible final summary as a required invariant.
    A clean helper completion with empty/whitespace final text fails closed;
    internal reasoning is not promoted into history. A max-token or
    content-filter completion remains incomplete and emits no replacement item.
    This amendment follows the sanitized count-only incident record in
    [`PROGRESS.md`](../../PROGRESS.md#historical-evidence-retained),
    where nine of 13 Gemini-routed compactions were stored as exactly empty
    `ocx1:` envelopes.
11. Amended 2026-08-13: publish context 202,752 and auto-compaction limit
    173,352 only on the managed `nvidia-glm-5.2` descriptor. Leave GLM's
    model-native 1M capability and all other provider-specific GLM rows
    untouched. Sources: [NVIDIA GLM 5.2 model page](https://build.nvidia.com/z-ai/glm-5.2),
    [NVIDIA API reference](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5.2),
    and the [NVIDIA hosted-endpoint limit report](https://forums.developer.nvidia.com/t/glm-5-2-context-issue/376165).
12. Amended 2026-08-25: publish exactly Qwen's low, medium, and xhigh reasoning
    rungs and use xhigh by default. The accepted private runtime profile owns
    the server prediction policy; public source must not reintroduce an obsolete
    output cap or translate xhigh into a fictitious picker level.

## Consequences

- Catalog metadata and the actual managed-local allocation cannot silently disagree.
- The managed local model never performs its own automatic compaction while
  this helper policy is configured. Gemini produces the external handoff.
- An HTTP 200 helper response alone is not accepted as proof of a valid
  compaction; replacement history requires a non-empty visible handoff.
- External review and compaction always use the configured Gemini helper.
  Native Codex compaction remains unmodified, and native review changes only
  at the explicit low-quota threshold.
- Auto-compaction limits default to 85.5% of context window across all models.
- 180K is the accepted managed-local default. The 192K and 256K rows are retired
  and remain present only in compatibility code and tests that migrate old state.
- Picker membership is startup-loaded by Codex. A catalog sync or quota
  decoration is not enough for an already-running Codex app; restart Codex to
  see changed rows.
- NVIDIA bundle badges may say `Free` because pricing/free-tier metadata says
  so, but the routes still require the user's protected API keys. NVIDIA's own
  setup documentation requires a personal API key: [NVIDIA NIM configuration](https://docs.nvidia.com/nim/large-language-models/latest/get-started/configuration.html).
- The managed NVIDIA GLM picker row reports the hosted endpoint's 202,752-token
  cap and compacts at 173,352. Other GLM routes may honestly publish different
  windows because they are separate provider contracts.
- Usage-row presentation remains implemented but its live acceptance and any
  further UI work are deferred until routed conversations, helpers, the managed local model,
  visibility, and lifecycle pass their corrective retest.

## Rollback

- Clear `autoReviewModel`, `autoCompactModel`, `helperTurnScope`,
  `helperTurnReasoningEffort`, and
  `helperTurnCodexRemainingPercentThreshold` through the supported helper-turn
  settings API.
- Revert the catalog/context-table commit and run `ocx sync`; restart Codex so
  it reloads the prior catalog.
- Do not delete managed-local artifacts or provider credentials as a rollback
  action.
