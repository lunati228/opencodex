import { existsSync, readFileSync } from "node:fs";

export type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|ps1|sh|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

/**
 * These are operator-facing records rather than product documentation. They may
 * describe public behavior, but must never become a published inventory of one
 * maintainer's devices, local artifacts, measurements, or timezone.
 */
const OPERATOR_DOCUMENT_PREFIXES = [
  "README-FORK.md",
  "PROGRESS.md",
  "BACKLOG.md",
  "CLAUDE.md",
  "scripts/OCX-RUN.md",
  "docs/local-integration/",
];

const MACHINE_LOCAL_TOOL_PREFIXES = [
  "tools/opencodex-staging/",
  "tools/ornith-benchmark/experiments/",
  "tools/release-gate/run-root-shards.mjs",
];

const PRIVATE_LOCAL_EMAIL_DOMAIN = "localhost";
// Catch generic student-address subdomains without encoding any institution.
const STUDENT_EMAIL_RE = /\b[A-Z0-9._%+-]+@(?:stud|student)\.[A-Z0-9.-]+\b/gi;
const PRIVATE_LOCAL_EMAIL_RE = new RegExp(
  String.raw`\b[A-Z0-9._%+-]+@${PRIVATE_LOCAL_EMAIL_DOMAIN}\b`,
  "gi",
);

/**
 * Placeholder addresses used in sample CLI output and UI specs inside `devlog/`.
 * Deliberately a short explicit list: each entry is a value a human chose as obviously
 * fake, and adding one is a reviewed change.
 */
const DEVLOG_PLACEHOLDER_EMAILS = new Set([
  ["1", "gmail.com"].join("@"),
  ["a", "b.com"].join("@"),
  ["work", "corp.com"].join("@"),
]);

/**
 * Exact fake probes preserved as historic scan evidence in the devlog publication
 * record. Keep this limited to that file and those values: the record proves all
 * three detectors worked on a staged file before the probe was removed. Construct
 * the strings from fragments so this scanner does not report its own allowances.
 */
const DEVLOG_PUBLICATION_PROOF_FILE = "devlog/_fin/260730_devlog_publication_feasibility/030_wp3_wp4_execution_record.md";
const DEVLOG_PUBLICATION_PROOF_TOKEN = ["sk-", "liveKeyShaped9", "x8w7v6u5", "t4s3r2q1p0"].join("");
const DEVLOG_PUBLICATION_PROOF_HOME_USERNAME = ["someone", "else"].join("");
const DEVLOG_PUBLICATION_PROOF_EMAIL = ["stranger", "third-party.example.org"].join("@");
const DEVLOG_AWS_DOCUMENTATION_SAMPLE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

/**
 * The sponsorship contact address published on purpose. It is the one email the project
 * WANTS in the tree, and only in the two files that carry the sponsor rule set. Anywhere
 * else — a devlog note, a test fixture, a comment — the same address still fails, because
 * there it would be a leak of contact data rather than a published channel.
 */
const SPONSORSHIP_CONTACT_EMAIL = ["jun", "lidgeai.com"].join("@");
const SPONSORSHIP_CONTACT_FILES = new Set(["SPONSORS.md", "README.md"]);

function gitLsFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ls-files failed: ${stderr.trim() || result.exitCode}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean);
}

function shouldScan(file: string): boolean {
  if (!TEXT_FILE_RE.test(file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  if (EXCLUDED_SUFFIXES.some(suffix => file.endsWith(suffix))) return false;
  return true;
}

function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** The full source line containing `index`, used for context-sensitive allowances. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && email === DEVLOG_PUBLICATION_PROOF_EMAIL) return true;
  if (SPONSORSHIP_CONTACT_FILES.has(file) && email.toLowerCase() === SPONSORSHIP_CONTACT_EMAIL) return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  // RFC 2606 / RFC 6761 reserve example.{com,net,org} and the entire
  // .example/.test namespaces for documentation and test fixtures.
  if (domain === "example.com"
    || domain === "example.net"
    || domain === "example.org"
    || domain === "test.com"
    || domain.endsWith(".example")
    || domain.endsWith(".test")) {
    return true;
  }
  // devlog records public commit authorship: PR absorption notes, cherry-pick
  // provenance, and `Co-authored-by:` trailers. Those addresses are already public in
  // this repository's git history, so redacting them here protects nothing while
  // destroying the attribution the notes exist to preserve. GitHub's own noreply form
  // is a public handle by construction.
  if (file.startsWith("devlog/")) {
    if (domain === "users.noreply.github.com") return true;
    if (DEVLOG_PLACEHOLDER_EMAILS.has(email.toLowerCase())) return true;
  }
  // URL-userinfo fixtures (https://user:pw@host/...) read as "pw@host" — not emails.
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  // External-provider bundle tests assert that a baseUrl carrying URL userinfo is
  // rejected even when the host is the correct one, so the fixture must use the
  // real NVIDIA host. Split so this line does not match its own rule.
  if (
    file === "tests/external-provider-bundles.test.ts"
    && email === ["user", "integrate.api.nvidia.com"].join("@")
  ) {
    return true;
  }
  return file.startsWith("tests/") && email === "a@b.com";
}

/**
 * Whether this occurrence is git-attribution provenance rather than contact data.
 *
 * `devlog/` notes quote commit and PR metadata verbatim so absorption and cherry-pick
 * decisions stay auditable: `Co-authored-by:` trailers, `author Name <addr>` citations,
 * and `Name <addr>` forms. Every such address is ALREADY public as commit authorship in
 * this repository, so redacting the note protects nothing and destroys the attribution.
 *
 * Matching the surrounding SHAPE rather than a list of addresses is deliberate: a new
 * contributor needs no scanner change, while a bare address pasted as contact detail
 * still fails.
 */
function isGitAttributionContext(line: string): boolean {
  return /co-authored-by:\s*.*<[^>]+>/i.test(line)
    || /\bauthor(?:ed by)?\b[^<]*<[^>]+>/i.test(line)
    || /signed-off-by:\s*.*<[^>]+>/i.test(line)
    // `handle <addr>` — the shape git itself prints for an identity. Requires a name
    // token before the angle brackets, so a bare address is not covered.
    || /[A-Za-z0-9._-]+\s*<[^@\s>]+@[^\s>]+>/.test(line)
    // A markdown table row citing commit provenance: a SHA cell plus the address.
    // Requires the 7+ hex SHA, so an arbitrary table of contacts is not covered.
    || (/^\s*\|/.test(line) && /\b[0-9a-f]{7,40}\b/.test(line));
}

function isTestFixtureFile(file: string): boolean {
  return file.startsWith("tests/")
    || file.includes("/tests/")
    || file.includes("/test/")
    || /\.test\.[cm]?[jt]sx?$/.test(file);
}

function isAllowedHomePath(file: string, username: string): boolean {
  // The official oven/bun image's fixed service user, not a workstation identity.
  if ((file.startsWith("docs-site/") || file.startsWith("devlog/")) && username === "bun") return true;
  if (username === "bun" && ["compose.yaml", "scripts/ci/docker-smoke.ts", "structure/02_config-and-codex-home.md"].includes(file)) return true;
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && username === DEVLOG_PUBLICATION_PROOF_HOME_USERNAME) return true;
  if (isTestFixtureFile(file)) {
    return true;
  }
  if (file.startsWith("docs/") && (username === "me" || username === "user")) return true;
  if (file.startsWith("docs-site/") && username === "example") return true;
  // Public devlog records may use only obvious placeholders. Real profile names do
  // not become safe merely because a command transcript quoted them.
  if (file.startsWith("devlog/") && (username === "u" || username === "user" || username === "me" || username === "test" || username === "example")) {
    return true;
  }
  return false;
}

/**
 * Windows equivalent of `isAllowedHomePath`. Tests and historical devlog records
 * contain deliberate path fixtures; operational code and current documentation do
 * not get a blanket exemption, so a pasted workstation profile path fails CI.
 */
function isAllowedWindowsHomePath(file: string, username: string): boolean {
  const folded = username.toLowerCase();
  if (isTestFixtureFile(file)) {
    return true;
  }
  if (file.startsWith("docs/") || file.startsWith("docs-site/")) {
    return ["[user]", "example", "me", "u", "user", "x"].includes(folded);
  }
  if (file.startsWith("devlog/")) {
    return [
      "...", "[user]", "example", "u", "user", "x",
    ].includes(folded);
  }
  return ["...", "[user]", "bob", "bob2", "error", "u", "user", "x"].includes(folded);
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  if (file === DEVLOG_PUBLICATION_PROOF_FILE && token === DEVLOG_PUBLICATION_PROOF_TOKEN) return true;
  if (
    file === "devlog/_fin/260729_go_cost_parity_stability/090_upstream_error_leak_hardening.md"
    && token === DEVLOG_AWS_DOCUMENTATION_SAMPLE
  ) return true;
  if (file.startsWith("tests/")) {
    // Test fixture sentinels: sk-rawsentinel..., sk-test-...
    return /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token)
      || /(?:fixture|DO_NOT_LEAK)/i.test(token);
  }
  if (file.startsWith("devlog/")) {
    // devlog quotes the same fixture sentinels its tests use, plus self-describing
    // placeholders written for redaction and warning examples. The allowance is
    // deliberately shape-based: a token must SAY it is fake. A real `sk-` key is high
    // entropy and would not match any of these words, so it still fails.
    return /^sk-(?:ant-)?(?:rawsentinel|test|warning|from|oat01-test)[A-Za-z0-9_-]*$/.test(token)
      || /^sk-[a-z-]*(?:sentinel|placeholder|redact|example|dummy|fake)[A-Za-z0-9_-]*$/.test(token);
  }
  return false;
}

function isAllowedBearerToken(file: string, token: string): boolean {
  if (!file.startsWith("tests/")) return false;
  return /^(?:access|stack|usage-debug)-token(?:-value)?-[A-Za-z0-9-]+$/.test(token);
}

function addFindingsForPattern(
  findings: Finding[],
  file: string,
  text: string,
  kind: string,
  pattern: RegExp,
  allow: (match: RegExpExecArray) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (allow(match)) continue;
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind,
      value: match[0],
    });
  }
}

function isOperatorDocument(file: string): boolean {
  return OPERATOR_DOCUMENT_PREFIXES.some(prefix => file === prefix || file.startsWith(prefix));
}

function isMachineLocalTool(file: string): boolean {
  return MACHINE_LOCAL_TOOL_PREFIXES.some(prefix => file === prefix || file.startsWith(prefix));
}

const GENERIC_SSH_HOST_ALIASES = new Set([
  "ci", "ci-host", "example", "host", "localhost", "remote", "server", "test", "user",
]);

function scansInfrastructureFingerprints(file: string): boolean {
  return file.startsWith("devlog/") || isOperatorDocument(file);
}

function isAllowedSshHostAlias(alias: string): boolean {
  return GENERIC_SSH_HOST_ALIASES.has(alias.toLowerCase());
}

function addInfrastructureFindings(findings: Finding[], file: string, text: string): void {
  if (!scansInfrastructureFingerprints(file)) return;
  addFindingsForPattern(
    findings,
    file,
    text,
    "ssh-host-alias",
    /(?:^|`)ssh\s+(?:-[A-Za-z0-9_-]+\s+)*([A-Za-z][A-Za-z0-9_.@-]*)(?=\s*(?:['"`]|$))/gm,
    match => isAllowedSshHostAlias(match[1] ?? ""),
  );
}

function addOperatorDocumentFindings(findings: Finding[], file: string, text: string): void {
  if (!isOperatorDocument(file)) return;

  addFindingsForPattern(
    findings,
    file,
    text,
    "absolute-local-path",
    /\b[A-Z]:[\\/][^\s"'<>`]+/gi,
    () => false,
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "runtime-hash",
    /\b[a-f0-9]{64}\b/gi,
    () => false,
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "hardware-fingerprint",
    /\b(?:cuda\d+|rtx\s*\d+|geforce|vram|motherboard|bios|pcie|all\s+\d+\s+(?:model\s+)?layers|\d+\/\d+\s+(?:model\s+)?layers)\b/gi,
    () => false,
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "benchmark-fingerprint",
    /\b\d+(?:\.\d+)?\s+(?:prompt\s+|generation\s+)?tok\/s\b/gi,
    () => false,
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "operator-timezone",
    /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z][A-Za-z0-9_+-]*\b|[+-](?:0\d|1\d|2[0-3]):[0-5]\d\b/g,
    () => false,
  );
}

/**
 * Scan already-read text.
 *
 * Split out of `scanFile` so a test can exercise the REAL detectors. This module runs its
 * scan on import, so a test that cannot call a function ends up re-declaring the patterns
 * instead — and then stays green even if a detector here is deleted.
 */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  addFindingsForPattern(
    findings,
    file,
    text,
    "home-path",
    /\/(?:Users|home)\/([A-Za-z0-9_-]+)\//g,
    match => isAllowedHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "windows-home-path",
    /\b[A-Z]:[\\/]+Users[\\/]+([^\\/\r\n"'<>`]+)(?=[\\/])/gi,
    match => isAllowedWindowsHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "email",
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    match =>
      isAllowedEmail(file, match[0])
      || (file.startsWith("devlog/") && isGitAttributionContext(lineAt(text, match.index ?? 0))),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "bearer-token",
    /Bearer\s+([A-Za-z0-9._-]{24,})/g,
    match => isAllowedBearerToken(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "token-looking",
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  /*
   * Meta Model API keys. The pattern above does not match them: the measured shape is
   * `LLM|<16 digits>|<27 chars>`, verified against a real key's grammar (never its value).
   * The `meta-muse` provider imports one of these, so a leak has to be detectable here.
   */
  addFindingsForPattern(
    findings,
    file,
    text,
    "meta-api-key",
    /\bLLM\|\d+\|[A-Za-z0-9_-]{10,}\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "private-key-header",
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    () => file === "tests/adapters/google/gcp-adc.test.ts",
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "private-email-domain",
    STUDENT_EMAIL_RE,
    () => false,
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "private-local-email",
    PRIVATE_LOCAL_EMAIL_RE,
    match => file.startsWith("tests/") && match[0].toLowerCase().endsWith(`@${PRIVATE_LOCAL_EMAIL_DOMAIN}`),
  );
  addInfrastructureFindings(findings, file, text);
  addOperatorDocumentFindings(findings, file, text);
  if (isMachineLocalTool(file) && !isTestFixtureFile(file)) {
    addFindingsForPattern(
      findings,
      file,
      text,
      "machine-local-tool-path",
      /\b[A-Z]:[\\/][^\s"'<>`]+/gi,
      match => /^C:[\\/]Windows(?:[\\/]|$)/i.test(match[0]),
    );
  }
  return findings;
}

export const scanTextForPrivacy = scanText;

function scanFile(file: string): Finding[] {
  return scanText(file, readFileSync(file, "utf-8"));
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} ${finding.kind}`;
}

export function scanTrackedPathForPrivacy(file: string): Finding[] {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized.startsWith("docs/screenshots/")) return [];
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (!/(?:^|[-_.])(logs?|requests?|conversations?|traces?|debug)(?:[-_.]|$)/i.test(basename)) {
    return [];
  }
  return [{ file, line: 0, kind: "sensitive-screenshot-asset", value: basename }];
}

export function scanTrackedFiles(files = gitLsFiles()): Finding[] {
  return files
    .filter(existsSync)
    .flatMap(file => [
      ...scanTrackedPathForPrivacy(file),
      ...(shouldScan(file) ? scanFile(file) : []),
    ]);
}

if (import.meta.main) {
  const findings = scanTrackedFiles();
  if (findings.length > 0) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      console.error(formatFinding(finding));
    }
    process.exit(1);
  }

  console.log("Privacy scan passed");
}
