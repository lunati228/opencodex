# 100.60 — jawcode Metadata Snapshot Plan

## Question

Can opencodex dynamically reuse jawcode's existing model defaults for context windows, capabilities,
and usage metadata?

## Short Answer

Yes, jawcode has richer metadata, but opencodex should not import it directly at runtime first.

Recommended approach:

```text
jawcode rich metadata -> build-time generated opencodex snapshot -> small opencodex projection -> verified Codex catalog fields
```

Do not do:

```text
dynamic import @jawcode-dev/ai at opencodex runtime -> spread jawcode Model into Codex catalog
```

## jawcode Sources

Primary static model registry:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.json
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts
```

`models.json` includes `contextWindow`, `maxTokens`, `reasoning`, `thinking`, `input`, `output`,
`cost`, `compat`, `wireModelId`, and `unlisted`.

Relevant jawcode paths:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts:22
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts:30
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts:34
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts:41
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/models.ts:50
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:874
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:898
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:899
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:936
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:938
```

Provider descriptors:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:48
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:60
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:64
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:128
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:296
```

jawcode structure docs summarize the catalog fields:

```text
<private-user-home>/Developer/new/700_projects/jawcode/structure/30_providers.md:149
<private-user-home>/Developer/new/700_projects/jawcode/structure/30_providers.md:151
<private-user-home>/Developer/new/700_projects/jawcode/structure/30_providers.md:152
<private-user-home>/Developer/new/700_projects/jawcode/structure/30_providers.md:156
```

## Current opencodex Shape

opencodex currently carries routed catalog models as:

```ts
export interface CatalogModel {
  id: string;
  provider: string;
  owned_by?: string;
}
```

Path:

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts:34
```

Provider config is also narrower:

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:204
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:208
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:209
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:222
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:227
```

## Direct Runtime Dependency Risk

`@jawcode-dev/ai` exports useful pieces:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/package.json:87
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/package.json:91
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/package.json:115
```

But runtime importing it into opencodex is risky:

- opencodex currently keeps runtime deps small;
- jawcode's package has a higher Bun floor than opencodex;
- it may pull in provider SDK and agent-specific surfaces;
- opencodex is meant to be a small proxy, not a full jawcode runtime;
- failures would have to degrade cleanly on every user install.

Current opencodex dependency baseline:

```text
<private-user-home>/Developer/new/700_projects/opencodex/package.json:18
<private-user-home>/Developer/new/700_projects/opencodex/package.json:31
```

## Recommended Projection

Generate a small opencodex-owned metadata file, for example:

```ts
export interface OcxModelMetadata {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  thinking?: unknown;
  compat?: {
    supportsReasoningEffort?: boolean;
    reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
    supportsUsageInStreaming?: boolean;
  };
  wireModelId?: string;
  unlisted?: boolean;
}
```

Generated source candidates:

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/generated/jawcode-model-metadata.ts
<private-user-home>/Developer/new/700_projects/opencodex/scripts/generate-jawcode-metadata.ts
```

Do not write these in this docs phase; this is the Phase 100 implementation target.

## Provider-ID Mapping

opencodex provider ids do not always match jawcode provider ids. The snapshot generator needs an
explicit mapping layer.

Examples:

| opencodex provider | possible jawcode source |
| --- | --- |
| `xai` | `xai` |
| `anthropic` | `anthropic` |
| `google` / `gemini` | Google descriptor ids |
| `moonshot` / `kimi` | Kimi/Moonshot descriptor ids |
| `openrouter` | `openrouter` |
| `alibaba` | `alibaba-coding-plan` or other Alibaba descriptor ids |
| `opencode-go` | `opencode-go` |

Correction: `opencode-go` is already in jawcode. It is not an unmapped custom-only source.

Evidence:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:130
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/descriptors.ts:178
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:859
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:862
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:2112
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:2338
```

jawcode models it as an OpenAI-compatible provider using:

```text
https://opencode.ai/zen/go/v1
```

with explicit API-resolution overrides for known OpenCode Go routing mismatches. The Phase 100
metadata generator should therefore map opencodex `opencode-go` directly to jawcode `opencode-go`
and reuse jawcode's discovered context/capability metadata where exact model ids match.

Policy:

```text
mapped exact provider/model -> use jawcode metadata
mapped provider but unknown model -> use provider default/conservative values
unmapped provider -> keep current opencodex conservative defaults
```

The generator must report unmapped providers and models instead of silently guessing.

## Context Window Mapping

jawcode's `contextWindow` is the best candidate for Codex catalog `context_window`.

jawcode's `maxTokens` is output-token metadata and should not be confused with prompt context.

Important warning from jawcode OpenAI-compatible discovery:

```text
max_prompt_tokens = prompt capacity
max_context_window_tokens = prompt + output
```

Do not map `max_context_window_tokens` directly to Codex `context_window`, because it can inflate
the prompt budget and break compaction thresholds.

Relevant jawcode paths:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:1694
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:1707
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:1742
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:1743
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts:1744
```

## Usage Mapping

jawcode has richer per-response usage:

```text
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:493
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:495
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:497
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:499
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:501
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:503
<private-user-home>/Developer/new/700_projects/jawcode/packages/ai/src/types.ts:514
```

opencodex currently has:

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:158
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:159
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts:160
```

Phase 100 implementation should extend opencodex response usage separately from catalog metadata:

```ts
interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}
```

jawcode quota `UsageReport` is separate and should be documented for dashboard/status only, not
confused with Responses token usage.

## First Implementation Slice

1. Add generated jawcode metadata snapshot.
2. Extend internal `CatalogModel` with optional metadata.
3. Use metadata for opencodex runtime gates first:
   - no vision if `input` lacks `image`;
   - no reasoning if `reasoning` is false or compat says reasoning effort unsupported;
   - reasoning raw/summary mapping from `compat.reasoningContentField` where reliable.
4. Only after parser verification, write Codex catalog fields:
   - `context_window`;
   - `max_context_window`;
   - `auto_compact_token_limit` or related fields if the installed Codex catalog accepts them.

## Risk Summary

- jawcode shape is camelCase; Codex catalog shape is snake_case.
- provider ids do not always match.
- total context-window fields can be semantically wrong for prompt budget.
- direct runtime dependency is too heavy for the first pass.
- stale generated snapshots need provenance and regeneration checks.
- fast/service-tier fields must remain stripped for routed models.
