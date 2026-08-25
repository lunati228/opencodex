import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Self-cleaning temporary roots for the harness tests.
 *
 * Every test previously called `mkdtemp(path.join(os.tmpdir(), "ornith-..."))`
 * directly and none of the 72 call sites removed the directory afterwards. A
 * single full harness run leaks one directory per call, which is how 1,737
 * `ornith-*` directories accumulated in the machine temp root.
 *
 * Registration is process-wide rather than per-test because `node --test`
 * gives each test file its own process, so an exit hook cleans up exactly the
 * roots that file created -- including when a test throws or an assertion
 * fails partway through.
 */
const created = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Exit handlers must be synchronous, so this uses rmSync deliberately.
  process.on("exit", () => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A leaked directory must never turn a passing test run into a failure.
      }
    }
    created.clear();
  });
}

/**
 * Create a temporary directory that is removed when this test process exits.
 *
 * @param {string} prefix mkdtemp prefix, e.g. `"ornith-artifacts-"`
 * @returns {Promise<string>} absolute path to the new directory
 */
export async function tempRoot(prefix) {
  installExitHook();
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.add(root);
  return root;
}

/**
 * Remove a root early, for tests that assert on directory absence or that
 * create many roots in a loop.
 *
 * @param {string} root path previously returned by {@link tempRoot}
 */
export async function releaseTempRoot(root) {
  created.delete(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

/** Roots still registered for cleanup. Exposed for the harness's own tests. */
export function trackedTempRoots() {
  return [...created];
}
