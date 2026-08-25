# 030 — `relPath()` home-prefix containment fix (D5, wp3)

Display-only defect in warning rendering: naive lowercase prefix match has no component
boundary (`R:\profiles\example2\x` renders as inside `~` for home `R:\profiles\example`) and applies
case-insensitive comparison on case-sensitive POSIX filesystems.

## Change map

| File | Op | What |
|------|----|------|
| `src/codex/project-config-warnings.ts` | MODIFY | rewrite `relPath` with `pathApi.relative` + full containment predicate; export for tests |
| `tests/` (project-config-warnings owner test) | MODIFY | boundary/exact-home/parent/cross-drive fixtures with `path.win32` |

## Diff — `src/codex/project-config-warnings.ts:225-231`

```diff
-function relPath(abs: string): string {
-  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
-  if (home && abs.toLowerCase().startsWith(home.toLowerCase())) {
-    return `~${abs.slice(home.length).replace(/\\/g, "/")}`;
-  }
-  return abs;
-}
+export function relPath(abs: string, pathApi: Pick<typeof import("node:path"), "relative" | "sep" | "isAbsolute"> = path): string {
+  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
+  if (!home) return abs;
+  // Platform-correct containment: relative() is case-insensitive on win32 and
+  // case-sensitive on posix; reject parent ("..", "..\\x") and cross-drive (absolute) results.
+  const rel = pathApi.relative(home, abs);
+  if (rel === "") return "~";
+  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return abs;
+  return `~/${rel.replace(/\\/g, "/")}`;
+}
```

(+ `import path from "node:path";` if not already imported in a compatible form.)

Behavior table (home `R:\profiles\example`, `pathApi = path.win32`):

| `abs` | old | new |
|-------|-----|-----|
| `R:\profiles\example\proj\.codex\config.toml` | `~/proj/.codex/config.toml` | same |
| `R:\profiles\example2\proj\config.toml` | `~2/proj/config.toml` (WRONG) | `R:\profiles\example2\proj\config.toml` |
| `R:\profiles\example` | `~` | `~` |
| `R:\profiles` (parent) | unchanged | unchanged (`rel === ".."`) |
| `S:\work\config.toml` (cross-drive) | unchanged | unchanged (`isAbsolute(rel)`) |
| posix home `/srv/profiles/Example`, abs `/srv/profiles/example/x` | `~/x` (WRONG case-fold) | `/srv/profiles/example/x` |

## Tests

Owner test file for project-config-warnings (locate at implementation P; create a
`describe("relPath containment")` block): six fixtures above, driven by injected
`path.win32` / `path.posix` and env `USERPROFILE`/`HOME` set-reset. Activation scenario
(C-ACTIVATION-GROUNDING-01): the `example` vs `example2` fixture drives the rejected-prefix
branch; cross-drive fixture drives the `isAbsolute` branch.

## Accept criteria

- All six fixtures pass; existing warning-rendering tests unchanged. Full gates at C.

## Out of scope

- Warning detection logic itself (only the display path changes).
