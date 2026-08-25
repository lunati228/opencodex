# External Review Gate (inactive prototype)

> **NOT LIVE:** this directory is not connected to OpenCodex, Codex, AGY,
> Antigravity hooks, MCP configuration, or any reviewer account.

This is a dependency-free, provider-neutral security core for approving one
exact structured process request and executing it at most once. It is intentionally
side-by-side with the existing `codex-antigravity-bridge`; it does not replace
or modify that bridge.

## Security contract

- Requests must be the exact minified UTF-8 bytes produced by
  `JSON.stringify` from exactly these ordered fields: `version`, absolute
  `executable`, `argv`, `cwd`, `timeoutMs`, `authLevel`, and a caller-generated
  128-bit lowercase-hex `requestNonce`. Duplicate keys,
  whitespace variants, escape-equivalent encodings, and noncanonical
  executable/cwd aliases are rejected. Windows accepts case-only spelling
  differences because its ordinary path comparison is case-insensitive.
- The reviewer receives the complete request bytes as Base64. No truncation is
  permitted.
- The approval binds the request/action hashes, canonical real-path
  working-directory, canonical executable identity (path, file metadata, and
  full executable-content SHA-256), project root, reviewer authorization,
  risk, request nonce, internal approval salt, expiry, and per-process runtime
  identity under HMAC-SHA-256. Each request nonce is atomically burned at first
  issuance; duplicate or concurrent reuse is rejected.
- The approval file is claimed by an atomic rename before use. A replay can
  produce at most one execution.
- A broker restart generates a different runtime identity, invalidating all
  outstanding approvals.
- Reviewer denial, timeout, malformed data, insufficient authorization,
  changed bytes, expiry, and replay fail closed.
- Executed processes use the approved absolute executable and argv with
  `shell:false`; PATH, PATHEXT, and COMSPEC are not inherited. Executable and
  cwd identities, including the full executable-content hash, are revalidated
  immediately before spawn. Output is not captured or persisted by this
  package. Timeout handling gives the Windows tree-killer an independent
  bounded grace period, always attempts direct child termination, consumes all
  termination errors, and returns a deterministic timed-out result even if the
  OS refuses to terminate a process.
- Audit records contain fixed-schema metadata and SHA-256 hashes. They never
  contain request bytes, command text, environment values, provider headers,
  or reviewer prose. Records are HMAC-authenticated and chained by sequence and
  previous-record hash. Before every append or verification, the complete
  existing chain is checked against a separately HMAC-authenticated expected
  head file. An atomic lock directory prevents overlapping writers; a stale
  lock fails closed.

## Provider adapter contract

A reviewer object has a stable, non-secret `providerId` and one method:

```js
const reviewer = {
  providerId: "example-reviewer",
  async review({
    requestBytes,
    requestSha256,
    commandSha256,
    executableIdentitySha256,
    cwdSha256,
    requiredAuthLevel,
    requestNonce,
  }) {
    return {
      decision: "allow",
      riskLevel: "low",
      authLevel: "medium",
      reasonCode: "SCOPED_ACTION",
    };
  },
};
```

`JsonHttpReviewer` is a generic HTTPS implementation with a 64 KiB response
limit, bounded Retry-After/exponential retry behavior, and a circuit breaker.
Its endpoint and authentication headers must come from a future protected
runtime configuration; this prototype provides no credential storage.

## Inactive broker-facing boundary

`InactiveBrokerAdapter.run()` accepts exactly the seven structured request
fields listed above. It never accepts an `approvalId`, creates and consumes the
opaque approval identifier internally, and returns only the executor outcome.

A future MCP wrapper may call only this adapter. It must not expose approval
identifiers to a model, accept model-supplied approval identifiers, or place an
approval identifier in model-visible tool output. If Codex `updatedInput` is
used during a later hook integration, the injected approval material remains
broker-private and must be removed before any model-visible serialization.
Direct shell and unified-exec calls remain denied; only this broker boundary may
reach the fixed reviewed executor. No MCP server, hook, trust entry, or live
configuration is implemented or registered by this prototype.

## Local verification

```powershell
Set-Location '<repo>\tools\external-review-gate'
node --test
```

The tests use temporary directories, synthetic secrets, fake HTTP responses,
and harmless child processes. They do not call a live reviewer.

The deterministic suite also covers a same-length executable rewrite with its
mtime restored, canonical executable/cwd alias rejection, Windows
case-insensitive path spelling, audit restart continuation, tail/all-record
deletion, expected-head tampering, concurrent `AuditLog` instances, caller
request-nonce tampering and duplicate issuance, broker-private approval
handling, project-root rebinding, pre-execution audit failure, and bounded HTTP
error-body disposal.

## Activation blockers

Do not connect this package to a live system until all of these are complete:

1. Provision an ACL-restricted runtime directory outside every project and Git
   worktree for HMAC keys, approvals, audit records, the authenticated audit
   head, and settings before-images. User-bound DPAPI protects secrets at rest
   but does not isolate them from another process running under the same user;
   live execution therefore also needs an appropriately restricted child token,
   sandbox, or separately privileged broker.
2. Bind each provider to an explicit canonical HTTPS endpoint allowlist and
   implement protected credential loading without logging values.
3. Run an actual Antigravity temporary-hook enforcement test in an isolated
   account/workspace. The deterministic test here executes the generated hook
   command but does not call Antigravity.
4. Capture and verify a real byte-exact settings before-image immediately
   before any settings mutation. Its manifest HMAC key must be protected with
   DPAPI or an equivalent user-bound store. Windows DACL, owner, attributes,
   and timestamps are not restored by this prototype and remain an activation
   blocker.
5. Treat the filesystem checks as fail-closed detection, not an OS transaction.
   Executable replacement remains possible after the final content rehash and
   before process creation unless executable directories are protected or a
   verified handle-based launcher is used.
6. On Windows, hashing the executable does not bind DLL dependencies. Current
   working-directory or other DLL search can load unreviewed project-controlled
   code into an otherwise approved executable. Live mode needs a narrowly
   approved executable set plus a launcher/process mitigation that prevents
   untrusted project paths from participating in DLL resolution.
7. This prototype deliberately uses `stdio: "ignore"`, so it provides no usable
   command output. Activation needs a bounded, redacted, nonpersistent output
   transport with explicit secret-leak, truncation, and backpressure tests.
8. Audit integration still needs hash-only originating parent/child
   session/thread attribution. Before activation, every side-effecting MCP and
   tool path must be inventoried and proven to pass through the gate without
   logging raw commands, private content, or credentials.
   Any future MCP wrapper may call only `InactiveBrokerAdapter.run`; it must
   reject model-supplied approval material, keep hook-injected approval state
   broker-private, and deny direct shell/unified-exec paths.
9. Windows timeout code accepts only a normalized absolute `SystemRoot` before
   deriving an absolute `System32\taskkill.exe` path, but that does not prove
   the environment value or binary publisher is trustworthy. Live mode must
   start from a trusted broker environment and validate/pin the system helper,
   or replace it with a constrained job-object/launcher design.
10. The audit record and authenticated head require two atomic renames. A crash
   between them deliberately leaves a detectable mismatch requiring manual
   recovery. This prototype does not fsync directory metadata, cannot prove
   power-loss durability, leaves a stale writer lock after a crash, and cannot
   detect deletion of the records, head, and containing directory together
   without an external trusted checkpoint. Replaying an older authentic head
   together with its matching truncated record prefix is likewise detectable
   only when a monotonic head/sequence checkpoint is anchored outside this
   mutable runtime directory.
11. Complete root-agent review, repository-wide tests, and an explicit manual
   activation decision.
