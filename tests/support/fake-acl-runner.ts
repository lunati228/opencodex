/**
 * Test preload: stop 60 unrelated suites from applying real Windows ACLs.
 *
 * This is not a new idea — it is the mechanism the suite already documents and
 * was simply never wired up. `tests/windows-secret-acl.test.ts` says so in its
 * own `beforeEach`:
 *
 *   "The full Windows suite preloads a non-Windows seam so unrelated tests do
 *    not spend seconds applying real ACLs. This dedicated file explicitly opts
 *    back into the host platform for its real integration cases."
 *
 * That file opts back in with `setPlatformForTests(null)`, and about twenty
 * other suites already call `setPlatformForTests("linux")` by hand for exactly
 * this reason. The preload just makes it the default instead of something each
 * new suite has to remember.
 *
 * Why it matters
 * --------------
 * `loadConfig` hardens the config directory, the config file, and auth.json
 * *sequentially*, each through a synchronous `Bun.spawnSync` of PowerShell.
 * Unloaded that costs ~0.4-0.5 s per call and succeeds. Under the full
 * 381-file matrix it does not fit: `HARDEN_DEADLINE_DEFAULT_MS` is 5,000 ms and
 * the bun test timeout is *also* 5,000 ms.
 *
 * Measured without this file: 4595 pass / 359 fail, and 356 of those 359 were
 * the same error, `ACL hardening failed (EACL)`. Every affected suite passes
 * alone — `tests/api-debug.test.ts` passes 12/12 in isolation but takes
 * 34.52 s, ~2.9 s per test against a 5 s limit, so there is no headroom left to
 * lose. See BACKLOG P42.
 *
 * Why the platform seam and not a fake runner
 * ------------------------------------------
 * An earlier attempt here replaced three seams — the SID resolver, the DACL
 * apply/verify runner, and the access verifier. It worked (203 tests in 3.45 s
 * instead of 34.52 s for one file) but it broke a real-behaviour case in
 * `windows-secret-acl.test.ts`, because that suite relies on the module
 * defaults being genuine and only overrides them per case. The platform seam
 * has no such problem: `hardenSecretPath` returns `{ ok: true }` at its
 * `effectivePlatform() !== "win32"` gate before touching any runner, and the
 * ACL suite's existing `setPlatformForTests(null)` restores the host platform
 * with no edit to that file at all.
 *
 * This does not weaken a gate. Real ACL behaviour is still exercised where it
 * is the subject, and production code is untouched — `setPlatformForTests` is a
 * pre-existing test-only entry point.
 */
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";

setPlatformForTests("linux");
