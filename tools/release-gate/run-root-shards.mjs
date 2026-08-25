#!/usr/bin/env node
/**
 * Root test matrix runner (release gate).
 *
 * Runs every `tests/**\/*.test.ts` file in its own fresh pinned-Bun process with
 * an isolated OPENCODEX_HOME, and records a fail-closed evidence manifest.
 *
 * Why one process per file: the suite mutates process-global state (CODEX_HOME,
 * OPENCODEX_HOME, real Windows ACLs) and several files start listeners. Sharing
 * a process makes failures order-dependent and unreproducible.
 *
 * Why serial: concurrent shards contend on real Windows ACL verification and
 * produce false timeouts. Measured on this host; do not parallelise.
 *
 * History: the previous revision resolved a shard on the child's `close` event,
 * which requires stdout AND stderr to reach EOF. A grandchild inheriting those
 * pipe handles keeps them open after the child is killed, so a shard could run
 * 24x past its watchdog (observed: 7,267,216 ms against a 300,000 ms watchdog on
 * tests/codex-v2-gate.test.ts, a file that passes standalone in 49 s). This
 * revision resolves on `exit` with a bounded pipe-drain grace, escalates the
 * kill, and records watchdog evidence so a hang can never be silently absorbed.
 *
 * Usage:
 *   node tools/release-gate/run-root-shards.mjs [--stop-on-first-failure]
 *                                               [--self-test-policy]
 *                                               [--only <substring>]
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const bun = process.env.RELEASE_GATE_BUN
  ?? join(repo, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const evidenceRoot = process.env.RELEASE_GATE_EVIDENCE_ROOT
  ?? join(repo, ".tmp", "release-gate");
const isolatedParent = process.env.RELEASE_GATE_ISOLATED_ROOT ?? tmpdir();

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(evidenceRoot, `root-shards-${runId}`);
const isolatedRoot = join(isolatedParent, `opencodex-root-shards-${runId}`);
const manifestPath = join(evidenceDir, "manifest.json");

/** Per-shard soft deadline. Slowest legitimate shard measured on this host: ~50 s. */
const watchdogMs = Number(process.env.RELEASE_GATE_WATCHDOG_MS ?? 300_000);
/** Grace after a kill attempt before escalating. */
const killGraceMs = 15_000;
/** Grace after `exit` for stdio pipes to drain before we stop waiting on them. */
const drainGraceMs = 2_000;
const maxCapturedBytes = 2 * 1024 * 1024;

const stopOnFirstFailure = process.argv.includes("--stop-on-first-failure");
const onlyIndex = process.argv.indexOf("--only");
const onlyFilter = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

/**
 * The exact set of tests allowed to skip, and only on win32. Anything else that
 * skips, crashes, times out, truncates output, or reports zero passes fails.
 */
const expectedWindowsSkipPolicy = new Map([
  [
    "tests/claude-agents-inject.test.ts",
    [
      "syncClaudeAgentDefs ownership contract (audit 071 #2/#3) > symlinks are never followed or pruned",
    ],
  ],
  [
    "tests/shutdown-launcher.test.ts",
    [
      "ocx launcher graceful shutdown > SIGINT to the launcher tears down the Bun proxy and restores Codex config (no orphan)",
      "ocx launcher graceful shutdown > SIGTERM to the launcher tears down the Bun proxy and restores Codex config (no orphan)",
      "ocx launcher graceful shutdown > SIGHUP to the launcher tears down the Bun proxy and restores Codex config (no orphan)",
    ],
  ],
]);

function assertContained(child, parent) {
  const exactChild = resolve(child);
  const exactParent = resolve(parent);
  if (
    exactChild === exactParent
    || !exactChild.toLowerCase().startsWith(`${exactParent.toLowerCase()}${sep}`)
  ) {
    throw new Error(`unsafe cleanup containment: ${exactChild}`);
  }
}

function walkTests(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkTests(target));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      found.push(relative(repo, target).replaceAll("\\", "/"));
    }
  }
  return found;
}

function git(...args) {
  const result = spawnSync("git.exe", args, {
    cwd: repo,
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function hashPath(hash, path, label) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      hashPath(hash, join(path, name), `${label}/${name}`);
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(`file:${label}\0`);
  hash.update(readFileSync(path));
}

/** Digest of HEAD + tracked diff + every untracked file, so tree drift during a run is fatal. */
function candidateDigest() {
  const hash = createHash("sha256");
  hash.update(git("rev-parse", "HEAD"));
  hash.update(git("diff", "--binary", "--no-ext-diff", "HEAD", "--", "."));
  const status = git("status", "--porcelain=v1", "-z")
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const row of status) {
    hash.update(`status:${row}\0`);
    if (!row.startsWith("?? ")) continue;
    const label = row.slice(3);
    const target = resolve(repo, label);
    if (
      target !== resolve(repo)
      && target.toLowerCase().startsWith(`${resolve(repo).toLowerCase()}${sep}`)
      && existsSync(target)
    ) {
      hashPath(hash, target, label.replaceAll("\\", "/"));
    }
  }
  return hash.digest("hex");
}

function writeManifest(manifest) {
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, manifestPath);
}

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxCapturedBytes) return combined;
  return combined.subarray(combined.length - maxCapturedBytes);
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Read per-test results from bun's JUnit report.
 *
 * The console reporter prints only aggregate counts -- it never names a skipped
 * test -- so an allowlist keyed on exact skipped-test names could not be
 * enforced by scraping stdout. JUnit carries the names, so the allowlist is
 * actually checkable. A missing or unparseable report is fatal, which also
 * covers crash, kill, and truncation.
 */
function parseJUnitReport(junitPath) {
  if (!existsSync(junitPath)) {
    return { ok: false, reason: "junit-report-missing", pass: 0, fail: 0, skip: 0, skippedTests: [] };
  }
  let xml;
  try {
    xml = readFileSync(junitPath, "utf8");
  } catch {
    return { ok: false, reason: "junit-report-unreadable", pass: 0, fail: 0, skip: 0, skippedTests: [] };
  }
  if (!xml.includes("<testsuites")) {
    return { ok: false, reason: "junit-report-malformed", pass: 0, fail: 0, skip: 0, skippedTests: [] };
  }

  let pass = 0;
  let fail = 0;
  const skippedTests = [];
  for (const match of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)) {
    const element = match[0];
    const name = decodeXmlAttribute(/\bname="([^"]*)"/.exec(element)?.[1] ?? "");
    const className = decodeXmlAttribute(/\bclassname="([^"]*)"/.exec(element)?.[1] ?? "");
    if (/<skipped\b/.test(element)) {
      skippedTests.push(className ? `${className} > ${name}` : name);
    } else if (/<failure\b|<error\b/.test(element)) {
      fail += 1;
    } else {
      pass += 1;
    }
  }
  return { ok: true, reason: null, pass, fail, skip: skippedTests.length, skippedTests };
}

function stringArraysEqual(left, right) {
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function classifyShardResult(testPath, result, hostPlatform = process.platform) {
  const expectedSkippedTests = hostPlatform === "win32"
    ? expectedWindowsSkipPolicy.get(testPath) ?? []
    : [];
  const expectedSkipCount = expectedSkippedTests.length;
  const accepted =
    result.junitOk === true
    && !result.timedOut
    && result.exitCode === 0
    && result.signal == null
    && result.fail === 0
    && result.skip === expectedSkipCount
    && stringArraysEqual(result.skippedTests, expectedSkippedTests)
    && !result.outputTruncated
    && (result.pass > 0 || expectedSkipCount > 0);
  const expectedPlatformSkip = expectedSkipCount > 0;
  const classification = !accepted
    ? "FAIL"
    : expectedPlatformSkip
      ? (result.pass > 0 ? "PASS_WITH_EXPECTED_PLATFORM_SKIP" : "EXPECTED_PLATFORM_SKIP")
      : "PASS";
  return {
    accepted,
    classification,
    expectedPlatformSkip,
    expectedSkipCount,
    expectedSkippedTests,
    passed: accepted && result.pass > 0,
  };
}

function runSkipPolicySelfTest() {
  const path = "tests/shutdown-launcher.test.ts";
  const names = expectedWindowsSkipPolicy.get(path);
  const base = {
    junitOk: true,
    timedOut: false, exitCode: 0, signal: null, fail: 0, pass: 0,
    skip: 3, skippedTests: names, outputTruncated: false,
  };
  const checks = [
    classifyShardResult(path, base, "win32").classification === "EXPECTED_PLATFORM_SKIP",
    // A missing or unparseable JUnit report is fatal even if everything else looks clean.
    !classifyShardResult(path, { ...base, junitOk: false }, "win32").accepted,
    !classifyShardResult("tests/plain.test.ts", { ...base, junitOk: false, skip: 0, skippedTests: [], pass: 5 }, "win32").accepted,
    !classifyShardResult("tests/not-allowlisted.test.ts", base, "win32").accepted,
    !classifyShardResult(path, base, "linux").accepted,
    !classifyShardResult(path, { ...base, skip: 2, skippedTests: names.slice(0, 2) }, "win32").accepted,
    !classifyShardResult(path, { ...base, skip: 4, skippedTests: [...names, "extra"] }, "win32").accepted,
    !classifyShardResult(path, { ...base, fail: 1 }, "win32").accepted,
    !classifyShardResult(path, { ...base, exitCode: 1 }, "win32").accepted,
    !classifyShardResult(path, { ...base, timedOut: true }, "win32").accepted,
    !classifyShardResult(path, { ...base, signal: "SIGKILL" }, "win32").accepted,
    !classifyShardResult(path, { ...base, outputTruncated: true }, "win32").accepted,
    !classifyShardResult(path, { ...base, skippedTests: [...names].reverse() }, "win32").accepted,
    classifyShardResult("tests/plain.test.ts", { ...base, skip: 0, skippedTests: [], pass: 5 }, "win32").classification === "PASS",
  ];
  if (checks.some(v => !v)) throw new Error("expected-platform-skip policy self-test failed");
}

if (process.argv.includes("--self-test-policy")) {
  runSkipPolicySelfTest();
  process.stdout.write("EXPECTED_PLATFORM_SKIP_POLICY_OK\n");
  process.exit(0);
}

function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  const r = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore", windowsHide: true, timeout: 30_000,
  });
  return r.status === 0;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Run one test file. Resolves on process `exit` (plus a bounded drain grace) so
 * a grandchild holding the inherited stdio pipes can never stall the matrix.
 */
function runOne(testPath, home, junitPath) {
  mkdirSync(home, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let watchdogFired = false;
  let killAttempts = 0;
  let hardKillFailed = false;

  return new Promise(resolveResult => {
    const child = spawn(
      bun,
      [
        "test",
        "--timeout", "60000",
        "--max-concurrency", "1",
        "--reporter", "junit",
        "--reporter-outfile", junitPath,
        testPath,
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          OPENCODEX_HOME: home,
          PATH: `${dirname(bun)};${process.env.PATH ?? ""}`,
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", c => { stdout = appendBounded(stdout, c); });
    child.stderr.on("data", c => { stderr = appendBounded(stderr, c); });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let drainTimer = null;

    const finish = resolvedOn => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      clearTimeout(escalationTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // Stop consuming the pipes; a surviving grandchild must not keep us alive.
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      const combined = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`;
      const report = parseJUnitReport(junitPath);
      resolveResult({
        testPath,
        testFileDigest: createHash("sha256")
          .update(readFileSync(join(repo, testPath)))
          .digest("hex"),
        pid: child.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode,
        signal: exitSignal,
        timedOut,
        watchdogFired,
        killAttempts,
        hardKillFailed,
        resolvedOn,
        junitOk: report.ok,
        junitReason: report.reason,
        junitPath,
        pass: report.pass,
        fail: report.fail,
        skip: report.skip,
        skippedTests: report.skippedTests,
        outputTruncated:
          stdout.length >= maxCapturedBytes || stderr.length >= maxCapturedBytes,
        capturedOutput: combined,
      });
    };

    // Soft deadline: ask the tree to die.
    const watchdogTimer = setTimeout(() => {
      if (settled) return;
      watchdogFired = true;
      timedOut = true;
      killAttempts += 1;
      killTree(child.pid);
    }, watchdogMs);

    // Hard deadline: if the process is still alive after the grace, give up on it
    // and record that fact rather than blocking the matrix forever.
    const escalationTimer = setTimeout(() => {
      if (settled) return;
      killAttempts += 1;
      killTree(child.pid);
      if (processAlive(child.pid)) hardKillFailed = true;
      timedOut = true;
      if (exitCode === null) exitCode = -1;
      finish("forced");
    }, watchdogMs + killGraceMs);

    child.once("error", error => {
      stderr = appendBounded(stderr, Buffer.from(`\nspawn error: ${error.message}\n`));
      if (exitCode === null) exitCode = -1;
      finish("spawn-error");
    });

    // `exit` fires when the process dies, regardless of inherited pipe handles.
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      drainTimer = setTimeout(() => finish("exit"), drainGraceMs);
    });

    // `close` means the pipes drained too; prefer it when it arrives in time.
    child.once("close", (code, signal) => {
      if (exitCode === null) exitCode = code;
      if (exitSignal == null) exitSignal = signal;
      finish("close");
    });
  });
}

mkdirSync(evidenceDir, { recursive: true });
mkdirSync(isolatedRoot, { recursive: true });
const junitDir = join(evidenceDir, "junit");
mkdirSync(junitDir, { recursive: true });
runSkipPolicySelfTest();

// Slowest / historically flakiest files first, so a systemic problem surfaces early.
const priorities = [
  "tests/claude-management-api.test.ts",
  "tests/cli-provider.test.ts",
  "tests/chat-completions-endpoint.test.ts",
  "tests/codex-v2-gate.test.ts",
  "tests/codex-routing.test.ts",
  "tests/server-auth.test.ts",
];
const discovered = walkTests(join(repo, "tests")).sort((a, b) => a.localeCompare(b, "en"));
if (new Set(discovered).size !== discovered.length) {
  throw new Error("duplicate test paths discovered");
}
for (const path of priorities) {
  if (!discovered.includes(path)) throw new Error(`missing priority shard: ${path}`);
}
let ordered = [
  ...priorities,
  ...discovered.filter(path => !priorities.includes(path)),
];
if (onlyFilter) ordered = ordered.filter(p => p.includes(onlyFilter));

const manifest = {
  schemaVersion: 3,
  runId,
  repo,
  bun,
  watchdogMs,
  killGraceMs,
  drainGraceMs,
  stopOnFirstFailure,
  onlyFilter,
  discoveredFiles: discovered.length,
  selectedFiles: ordered.length,
  expectedPlatformSkips: Object.fromEntries(
    process.platform === "win32" ? expectedWindowsSkipPolicy : new Map(),
  ),
  candidateDigestBefore: candidateDigest(),
  candidateDigestAfter: null,
  startedAt: new Date().toISOString(),
  endedAt: null,
  complete: false,
  failures: [],
  results: [],
};
writeManifest(manifest);

process.stdout.write(
  `ROOT_SHARDS_START files=${ordered.length} watchdog=${watchdogMs}ms `
  + `evidence=${evidenceDir}\n`,
);

let failed = false;
for (let index = 0; index < ordered.length; index += 1) {
  const testPath = ordered[index];
  const safeName = `${String(index + 1).padStart(3, "0")}-${basename(testPath)}`;
  const home = join(isolatedRoot, safeName);
  const result = await runOne(testPath, home, join(junitDir, `${safeName}.junit.xml`));
  const classification = classifyShardResult(testPath, result);
  const publicResult = { ...result, ...classification };
  delete publicResult.capturedOutput;
  manifest.results.push(publicResult);

  if (classification.accepted) {
    assertContained(home, isolatedRoot);
    rmSync(home, { recursive: true, force: true });
  } else {
    failed = true;
    manifest.failures.push({
      index: index + 1,
      testPath,
      classification: classification.classification,
      exitCode: result.exitCode,
      signal: result.signal,
      junitOk: result.junitOk,
      junitReason: result.junitReason,
      skippedTests: result.skippedTests,
      expectedSkippedTests: classification.expectedSkippedTests,
      timedOut: result.timedOut,
      watchdogFired: result.watchdogFired,
      hardKillFailed: result.hardKillFailed,
      resolvedOn: result.resolvedOn,
      durationMs: result.durationMs,
      pass: result.pass,
      fail: result.fail,
      skip: result.skip,
    });
    writeFileSync(join(evidenceDir, `${safeName}.failure.log`), result.capturedOutput, "utf8");
  }
  writeManifest(manifest);

  if (
    !classification.accepted
    || classification.expectedPlatformSkip
    || index < priorities.length
    || (index + 1) % 20 === 0
    || result.durationMs >= 60_000
  ) {
    process.stdout.write(
      `[${index + 1}/${ordered.length}] ${classification.classification} ${testPath} `
      + `${(result.durationMs / 1000).toFixed(1)}s `
      + `pass=${result.pass} fail=${result.fail} skip=${result.skip}`
      + `${result.watchdogFired ? " WATCHDOG" : ""}`
      + `${result.hardKillFailed ? " HARD-KILL-FAILED" : ""}\n`,
    );
  }

  if (failed && stopOnFirstFailure) break;
}

manifest.candidateDigestAfter = candidateDigest();
manifest.endedAt = new Date().toISOString();
manifest.complete =
  !failed
  && manifest.results.length === ordered.length
  && !onlyFilter
  && manifest.candidateDigestAfter === manifest.candidateDigestBefore;
writeManifest(manifest);

if (existsSync(isolatedRoot) && readdirSync(isolatedRoot).length === 0) {
  rmSync(isolatedRoot, { recursive: true, force: true });
}

const totals = manifest.results.reduce(
  (sum, row) => ({
    pass: sum.pass + row.pass,
    fail: sum.fail + row.fail,
    skip: sum.skip + row.skip,
  }),
  { pass: 0, fail: 0, skip: 0 },
);

if (!manifest.complete) {
  process.stderr.write(
    `ROOT_SHARDS_INCOMPLETE files=${manifest.results.length}/${ordered.length} `
    + `pass=${totals.pass} fail=${totals.fail} failures=${manifest.failures.length}\n`
    + `${manifest.failures.map(f => `  #${f.index} ${f.testPath} ${f.classification}`).join("\n")}\n`
    + `evidence=${manifestPath}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `ROOT_SHARDS_COMPLETE files=${manifest.results.length} `
    + `pass=${totals.pass} fail=${totals.fail} expectedPlatformSkip=${totals.skip}\n`
    + `evidence=${manifestPath}\n`,
  );
}
