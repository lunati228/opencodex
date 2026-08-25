import path from "node:path";

const MICROSOFT_WINDOWS_SUBJECT =
  "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const MICROSOFT_WINDOWS_ISSUER =
  "CN=Microsoft Windows Production PCA 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";

export const PINNED_WINDOWS_PROCESS_CONTROL = Object.freeze({
  expected_windows_root: "C:\\Windows",
  helpers: Object.freeze({
    taskkill: Object.freeze({
      filename: "taskkill.exe",
      bytes: 118_784,
      sha256:
        "1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7",
      authenticode_status: "Valid",
      signature_type: "Catalog",
      is_os_binary: true,
      evidence_kind: "recorded_authenticode_evidence_bound_to_sha256",
      signer_subject: MICROSOFT_WINDOWS_SUBJECT,
      signer_issuer: MICROSOFT_WINDOWS_ISSUER,
      signer_thumbprint: "3B77DB29AC72AA6B5880ECB2ED5EC1EC6601D847",
    }),
    typeperf: Object.freeze({
      filename: "typeperf.exe",
      bytes: 81_920,
      sha256:
        "91af8ea302e2d8e2bc0e8623f59412b9994e4617d160cd3a0af22da9acb24ca0",
      authenticode_status: "Valid",
      signature_type: "Catalog",
      is_os_binary: true,
      evidence_kind: "recorded_authenticode_evidence_bound_to_sha256",
      signer_subject: MICROSOFT_WINDOWS_SUBJECT,
      signer_issuer: MICROSOFT_WINDOWS_ISSUER,
      signer_thumbprint: "FACDE3D80E99AFCC15E08AC5A69BD22785287F79",
    }),
  }),
});

function canonicalWindowsPath(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes("\0")
  ) {
    throw new Error("INVALID_WINDOWS_PROCESS_CONTROL_ROOT");
  }
  return path.win32.normalize(value).replace(/[\\]+$/, "").toLowerCase();
}

export function validateWindowsProcessControl(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("MISSING_WINDOWS_PROCESS_CONTROL");
  }
  if (
    canonicalWindowsPath(policy.expected_windows_root) !==
    canonicalWindowsPath(
      PINNED_WINDOWS_PROCESS_CONTROL.expected_windows_root,
    )
  ) {
    throw new Error("WINDOWS_PROCESS_CONTROL_ROOT_MISMATCH");
  }
  for (const [name, expected] of Object.entries(
    PINNED_WINDOWS_PROCESS_CONTROL.helpers,
  )) {
    const actual = policy.helpers?.[name];
    if (
      !actual ||
      Object.keys(expected).some((key) => actual[key] !== expected[key]) ||
      Object.keys(actual).some((key) => !Object.hasOwn(expected, key))
    ) {
      throw new Error(`WINDOWS_PROCESS_CONTROL_EVIDENCE_MISMATCH: ${name}`);
    }
  }
  if (
    Object.keys(policy.helpers ?? {}).some(
      (name) => !Object.hasOwn(PINNED_WINDOWS_PROCESS_CONTROL.helpers, name),
    )
  ) {
    throw new Error("WINDOWS_PROCESS_CONTROL_EVIDENCE_UNEXPECTED");
  }
  return structuredClone(policy);
}

export function canonicalPinnedWindowsRoot(policy) {
  const validated = validateWindowsProcessControl(policy);
  return path.win32.normalize(validated.expected_windows_root);
}
