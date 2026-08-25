# 120.12 — 120.4 Capability Flag Enable + HTTP Fallback

## Objective

Once the MVP endpoint (`10_`) is live and tested, advertise `supports_websockets` **intentionally
and centrally**, so Codex opens WS against `ocx`. Today the flag leaks through two different
paths (`00_overview.md`): routed is stripped at `codex-catalog.ts:78`; native simply inherits
none from the current template but **could** leak it from a future template (no native strip).
This sub-phase puts both under one config-gated switch and verifies Codex's HTTP fallback as the
safety net.

## Evidence

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts:78        routed strip (delete supports_websockets)
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts:145-154   deriveEntry — native clone (no strip → latent leak)
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts:195       buildCatalogEntries(template, gptSlugs, goModels, featured)
<private-user-home>/Developer/codex/codex-cli/codex-rs/core/src/client.rs:772            Codex WS selection on supports_websockets
```

Verified current state: served catalog `<private-user-home>/.codex/opencodex-catalog.json` has zero
`supports_websockets` (so Codex attempts no WS today).

## Design

Add a single config switch and a **central override** in `buildCatalogEntries`, so every emitted
entry's flag is set deterministically (overriding both the routed strip and any native template
leak):

- `config.websockets?: boolean` (default `false`) in `OcxConfig`.
- `buildCatalogEntries(..., wsEnabled)`: after each entry is derived, `if (wsEnabled)
  entry.supports_websockets = true; else delete entry.supports_websockets;` — for **native and
  routed alike**. This makes the advertised capability match the actually-implemented endpoint
  and closes the native-leak risk in one place.

## Files

### MODIFY

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/types.ts   (or wherever OcxConfig is defined)
```

```diff
 export interface OcxConfig {
   // … existing fields …
+  /** Advertise supports_websockets so Codex opens the WS endpoint (120). Default false until 120.2 ships. */
+  websockets?: boolean;
 }
```

### MODIFY

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts
```

Thread a `wsEnabled` flag into `buildCatalogEntries` and apply the central override:

```diff
-export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[], featured?: string[]): RawEntry[] {
+export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[], featured?: string[], wsEnabled = false): RawEntry[] {
   // … existing derivation of native + routed entries into `entries` …
+  // Central capability override: the advertised flag must match the implemented endpoint (120).
+  // Overrides both the routed strip (:78) and any native template leak (:145-154).
+  for (const entry of entries) {
+    if (wsEnabled) entry.supports_websockets = true;
+    else delete entry.supports_websockets;
+  }
   return entries;
 }
```

(`delete entry.supports_websockets` at `:78` may stay as defense-in-depth; the central override
is authoritative.)

### MODIFY — call sites pass the flag

Both `buildCatalogEntries` call sites (verified):

```text
<private-user-home>/Developer/new/700_projects/opencodex/src/server.ts:537       (/v1/models codex catalog response)
<private-user-home>/Developer/new/700_projects/opencodex/src/codex-catalog.ts:330 (on-disk catalog injection, goEntries)
```

```diff
-  return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels) });
+  return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels, config.websockets ?? false) });
```

The `codex-catalog.ts:330` injection call (`goEntries = buildCatalogEntries(...)`) needs the same
5th-arg addition; thread `config.websockets` into that function's caller.

## Verification

```bash
bun test tests/codex-catalog.test.ts
bun test tests
bun x tsc --noEmit
```

Add catalog tests:

- `websockets: false` (default) → no entry has `supports_websockets` (native **or** routed),
  even if the template carries it (inject a template with the flag and assert it is removed).
- `websockets: true` → every served entry has `supports_websockets: true`.

**Live fallback check (the safety net):**

1. `websockets: false`, regenerate the served catalog → confirm `<private-user-home>/.codex/opencodex-catalog.json`
   has no flag and Codex uses HTTP (no WS attempt).
2. `websockets: true` with the `10_` endpoint running → Codex opens WS and a turn completes.
3. `websockets: true` with the endpoint **stopped** → confirm Codex falls back to HTTP (or fails
   cleanly) rather than hanging; record the behavior. This is the RC6 guard rail.

Expected:

```text
flag off → zero advertisement (native+routed); flag on → uniform advertisement
endpoint up + flag on → WS turn completes; endpoint down → HTTP fallback (no hang)
```

## Commit

```text
[agent] feat: gate supports_websockets advertisement behind config.websockets
```
