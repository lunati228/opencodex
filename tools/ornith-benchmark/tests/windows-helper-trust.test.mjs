import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertWindowsTreeToolsAvailable,
  trustedWindowsTreeExecutables,
} from "../src/windows-process-tree.mjs";
import {
  PINNED_WINDOWS_PROCESS_CONTROL,
  validateWindowsProcessControl,
} from "../src/windows-helper-trust.mjs";

test("Windows process-control evidence pins root, hashes, and Microsoft signatures", () => {
  const validated = validateWindowsProcessControl(
    PINNED_WINDOWS_PROCESS_CONTROL,
  );
  assert.equal(validated.expected_windows_root, "C:\\Windows");
  assert.equal(
    validated.helpers.taskkill.sha256,
    "1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7",
  );
  assert.equal(
    validated.helpers.typeperf.sha256,
    "91af8ea302e2d8e2bc0e8623f59412b9994e4617d160cd3a0af22da9acb24ca0",
  );
  for (const helper of Object.values(validated.helpers)) {
    assert.equal(helper.authenticode_status, "Valid");
    assert.match(helper.signer_subject, /^CN=Microsoft Windows,/);
    assert.match(helper.signer_thumbprint, /^[A-F0-9]{40}$/);
  }

  const forged = structuredClone(PINNED_WINDOWS_PROCESS_CONTROL);
  forged.helpers.taskkill.sha256 = "0".repeat(64);
  assert.throws(
    () => validateWindowsProcessControl(forged),
    /WINDOWS_PROCESS_CONTROL_EVIDENCE_MISMATCH: taskkill/,
  );
});

test("Windows helper selection rejects an inherited forged SystemRoot", () => {
  assert.throws(
    () =>
      trustedWindowsTreeExecutables({
        SystemRoot: "G:\\attacker-controlled-windows",
      }),
    /TRUSTED_SYSTEM32_ROOT_MISMATCH/,
  );
});

test(
  "installed System32 helpers are ordinary files matching the pinned identities",
  { skip: process.platform !== "win32" },
  async () => {
    const executables = await assertWindowsTreeToolsAvailable({
      SystemRoot: "C:\\Windows",
    });
    assert.equal(
      executables.taskkill.toLowerCase(),
      path.win32.join("C:\\Windows", "System32", "taskkill.exe").toLowerCase(),
    );
    assert.equal(
      executables.typeperf.toLowerCase(),
      path.win32.join("C:\\Windows", "System32", "typeperf.exe").toLowerCase(),
    );
  },
);
