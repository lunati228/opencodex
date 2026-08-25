import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAllowlistedCommand } from "./command.mjs";
import { sha256Bytes, sha256File } from "./hash.mjs";
import { resolveContainedPath } from "./security.mjs";

const PROTECTED_PREFIXES = [".git", ".ornith-control", ".ornith-hidden"];
const NETWORK_GUARD = fileURLToPath(
  new URL("../security/network-guard.cjs", import.meta.url),
);

function normalizeRelativePath(relativePath) {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\/+/, "");
}

function protectedPath(relativePath) {
  const first = normalizeRelativePath(relativePath)
    .split("/", 1)[0]
    .toLowerCase();
  return PROTECTED_PREFIXES.includes(first);
}

function assertNotProtected(relativePath) {
  if (protectedPath(relativePath)) {
    throw new Error(`PROTECTED_PATH: ${relativePath}`);
  }
}

function pathAllowed(relativePath, allowedPaths) {
  const normalized = normalizeRelativePath(relativePath);
  const comparable = process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
  return allowedPaths.some((rule) => {
    const normalizedRule = normalizeRelativePath(rule);
    const comparableRule = process.platform === "win32"
      ? normalizedRule.toLowerCase()
      : normalizedRule;
    if (comparableRule.endsWith("/**")) {
      return comparable.startsWith(comparableRule.slice(0, -2));
    }
    return comparable === comparableRule;
  });
}

async function resolveVisiblePath(root, requestedPath) {
  const filePath = await resolveContainedPath(root, requestedPath);
  const realRoot = await realpath(root);
  const relativePath = normalizeRelativePath(path.relative(realRoot, filePath));
  assertNotProtected(relativePath);

  let cursor = realRoot;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`REPARSE_POINT_REJECTED: ${relativePath}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return { filePath, relativePath };
}

async function visibleFiles(root, cursor = root) {
  const output = [];
  const entries = await readdir(cursor, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(cursor, entry.name);
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (protectedPath(relative)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`REPARSE_POINT_REJECTED: ${relative}`);
    }
    if (entry.isDirectory()) output.push(...(await visibleFiles(root, absolute)));
    if (entry.isFile()) output.push(relative);
  }
  return output;
}

function runTestsPolicyError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

async function expandedCommands(fixtureCase, caseRoot) {
  const declaredArguments = [
    "--require",
    "@network_guard",
    "--test",
    "tests/focused.test.mjs",
    ".ornith-hidden/oracle.test.mjs",
  ];
  const declared = fixtureCase.allowed_commands.map((command) => {
    if (command.executable !== "@node") {
      throw runTestsPolicyError(
        "RUN_TESTS_EXECUTABLE_FORBIDDEN",
        String(command.executable),
      );
    }
    if (
      JSON.stringify(command.args) !== JSON.stringify(declaredArguments)
    ) {
      throw runTestsPolicyError(
        "RUN_TESTS_ARGV_FORBIDDEN",
        JSON.stringify(command.args),
      );
    }
    return { ...command };
  });
  const realRoot = await realpath(caseRoot);
  const visibleReadTargets = new Set();
  for (const relativePath of await visibleFiles(caseRoot)) {
    const resolved = await resolveVisiblePath(caseRoot, relativePath);
    if (relativePath === "tests/focused.test.mjs") continue;
    const firstSegment = relativePath.split("/", 1)[0];
    visibleReadTargets.add(resolved.filePath);
    if (relativePath.includes("/")) {
      visibleReadTargets.add(path.join(realRoot, firstSegment));
    }
  }
  const permissionArguments = [
    "--permission",
    ...[...visibleReadTargets]
      .sort((left, right) => left.localeCompare(right))
      .map((target) => `--allow-fs-read=${target}`),
    `--allow-fs-read=${NETWORK_GUARD}`,
    "--require",
    NETWORK_GUARD,
  ];
  const oraclePath = await resolveContainedPath(
    caseRoot,
    ".ornith-hidden/oracle.test.mjs",
  );
  const oracleMetadata = await lstat(oraclePath);
  if (!oracleMetadata.isFile() || oracleMetadata.isSymbolicLink()) {
    throw runTestsPolicyError(
      "RUN_TESTS_ORACLE_INVALID",
      ".ornith-hidden/oracle.test.mjs",
    );
  }
  return declared.flatMap((command) => [
    {
      id: `${command.id}:focused`,
      executable: process.execPath,
      args: [
        ...permissionArguments,
        "--input-type=module",
        "-",
      ],
    },
    {
      id: `${command.id}:oracle`,
      executable: process.execPath,
      args: [
        ...permissionArguments,
        "--input-type=module",
        "-",
      ],
    },
  ]);
}

async function listFiles(context) {
  return { ok: true, files: await visibleFiles(context.caseRoot) };
}

async function readVisibleFile(context, input) {
  const { filePath, relativePath } = await resolveVisiblePath(
    context.caseRoot,
    input.path,
  );
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`NOT_A_FILE: ${input.path}`);
  if (metadata.size > 1024 * 1024) throw new Error(`FILE_TOO_LARGE: ${input.path}`);
  return {
    ok: true,
    path: relativePath,
    content: await readFile(filePath, "utf8"),
    sha256: await sha256File(filePath),
  };
}

async function searchText(context, input) {
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    input.query.length > 256
  ) {
    throw new Error("INVALID_SEARCH_QUERY");
  }
  const matches = [];
  for (const relativePath of await visibleFiles(context.caseRoot)) {
    const absolute = await resolveContainedPath(context.caseRoot, relativePath);
    const content = await readFile(absolute, "utf8");
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.includes(input.query)) {
        matches.push({ path: relativePath, line: index + 1, text: line });
      }
      if (matches.length >= 200) {
        return { ok: true, matches, truncated: true };
      }
    }
  }
  return { ok: true, matches, truncated: false };
}

async function applyStructuredPatch(context, input) {
  const { filePath, relativePath } = await resolveVisiblePath(
    context.caseRoot,
    input.path,
  );
  if (!pathAllowed(relativePath, context.fixtureCase.allowed_paths)) {
    throw new Error(`PATH_NOT_ALLOWLISTED: ${relativePath}`);
  }
  let exists = true;
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (!exists) {
    if (
      input.expected_sha256 !== null ||
      typeof input.create_content !== "string" ||
      input.replacements !== undefined
    ) {
      throw new Error("CREATE_REQUIRES_NULL_HASH_AND_CONTENT");
    }
    if (Buffer.byteLength(input.create_content) > 1024 * 1024) {
      throw new Error("PATCH_RESULT_TOO_LARGE");
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.create_content, {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      ok: true,
      created: true,
      sha256: sha256Bytes(Buffer.from(input.create_content, "utf8")),
    };
  }
  if (!/^[a-f0-9]{64}$/.test(input.expected_sha256 ?? "")) {
    throw new Error("INVALID_EXPECTED_SHA256");
  }
  if (
    !Array.isArray(input.replacements) ||
    input.replacements.length < 1 ||
    input.replacements.length > 20 ||
    input.create_content !== undefined
  ) {
    throw new Error("INVALID_REPLACEMENTS");
  }
  const currentHash = await sha256File(filePath);
  if (currentHash !== input.expected_sha256) {
    throw new Error(
      `STALE_FILE_HASH: expected=${input.expected_sha256} actual=${currentHash}`,
    );
  }

  context.attempts ??= new Map();
  const attemptKey = `apply_patch:${relativePath}`;
  const attempt = (context.attempts.get(attemptKey) ?? 0) + 1;
  context.attempts.set(attemptKey, attempt);
  if (
    context.fixtureCase.fault_injection?.tool === "apply_patch" &&
    context.fixtureCase.fault_injection.attempt === attempt
  ) {
    return {
      ok: false,
      error_code: context.fixtureCase.fault_injection.error_code,
      stdout: "",
      stderr: "Injected deterministic write conflict.",
      exit_code: null,
      duration_ms: 0,
    };
  }

  let content = await readFile(filePath, "utf8");
  for (const replacement of input.replacements) {
    if (
      typeof replacement.old !== "string" ||
      replacement.old.length === 0 ||
      typeof replacement.new !== "string"
    ) {
      throw new Error("INVALID_REPLACEMENT");
    }
    const first = content.indexOf(replacement.old);
    const last = content.lastIndexOf(replacement.old);
    if (first < 0) throw new Error("PATCH_CONTEXT_NOT_FOUND");
    if (first !== last) throw new Error("PATCH_CONTEXT_AMBIGUOUS");
    content =
      content.slice(0, first) +
      replacement.new +
      content.slice(first + replacement.old.length);
  }
  if (Buffer.byteLength(content) > 1024 * 1024) {
    throw new Error("PATCH_RESULT_TOO_LARGE");
  }
  await writeFile(filePath, content, "utf8");
  return {
    ok: true,
    error_code: null,
    stdout: "",
    stderr: "",
    exit_code: null,
    duration_ms: 0,
    sha256: sha256Bytes(Buffer.from(content, "utf8")),
  };
}

async function getDiff(context) {
  const baseline = JSON.parse(
    await readFile(
      path.join(context.caseRoot, ".ornith-control", "baseline.json"),
      "utf8",
    ),
  );
  const visible = await visibleFiles(context.caseRoot);
  const baselineVisible = new Map(
    baseline
      .filter(({ role }) => role === "visible")
      .map((file) => [file.path.replaceAll("\\", "/"), file]),
  );
  const changedPaths = [];
  const changes = [];
  for (const relativePath of new Set([...baselineVisible.keys(), ...visible])) {
    const before = baselineVisible.get(relativePath);
    let afterSha = null;
    if (visible.includes(relativePath)) {
      afterSha = await sha256File(
        await resolveContainedPath(context.caseRoot, relativePath),
      );
    }
    if (!before || before.sha256 !== afterSha) {
      changedPaths.push(relativePath);
      changes.push({
        path: relativePath,
        status: !before ? "added" : afterSha === null ? "deleted" : "modified",
        before_sha256: before?.sha256 ?? null,
        after_sha256: afterSha,
      });
    }
  }
  changedPaths.sort();
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, changed_paths: changedPaths, changes };
}

async function runTests(context, input, { timeoutMs = 120_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("TOOL_TIME_CAP_EXCEEDED");
  }
  const declared = context.fixtureCase.allowed_commands.find(
    ({ id }) => id === input.command_id,
  );
  if (!declared) {
    throw new Error(`COMMAND_NOT_ALLOWLISTED: ${input.command_id}`);
  }
  const allowlist = await expandedCommands(
    context.fixtureCase,
    context.caseRoot,
  );
  const oraclePath = await resolveContainedPath(
    context.caseRoot,
    ".ornith-hidden/oracle.test.mjs",
  );
  const focusedPath = await resolveContainedPath(
    context.caseRoot,
    "tests/focused.test.mjs",
  );
  const focusedSource = await readFile(focusedPath);
  const oracleSource = await readFile(oraclePath);
  const phaseCommands = ["focused", "oracle"].map((phase) => {
    const command = allowlist.find(
      ({ id }) => id === `${input.command_id}:${phase}`,
    );
    if (!command) {
      throw new Error(`COMMAND_NOT_ALLOWLISTED: ${input.command_id}:${phase}`);
    }
    return {
      phase,
      command,
      cwd:
        phase === "oracle"
          ? path.join(context.caseRoot, ".ornith-hidden")
          : path.join(context.caseRoot, "tests"),
      stdin: phase === "oracle" ? oracleSource : focusedSource,
    };
  });
  const results = [];
  const deadline = Date.now() + timeoutMs;
  for (const { phase, command, cwd, stdin } of phaseCommands) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1) throw new Error("TOOL_TIME_CAP_EXCEEDED");
    const result = await runAllowlistedCommand({
      command: { executable: command.executable, args: command.args },
      allowlist,
      cwd,
      timeoutMs: Math.min(120_000, remainingMs),
      maxOutputBytes: 512 * 1024,
      stdin,
    });
    results.push({ phase, ...result });
  }
  const failure = results.find(({ ok }) => !ok);
  return {
    ok: failure === undefined,
    error_code: failure?.error_code ?? null,
    stdout: results
      .map(({ phase, stdout }) => `[${phase}]\n${stdout}`)
      .join("\n"),
    stderr: results
      .map(({ phase, stderr }) => `[${phase}]\n${stderr}`)
      .join("\n"),
    exit_code: failure?.exit_code ?? results.at(-1)?.exit_code ?? null,
    signal: failure?.signal ?? null,
    duration_ms: results.reduce(
      (total, { duration_ms: durationMs }) => total + durationMs,
      0,
    ),
    stdout_truncated: results.some(({ stdout_truncated }) => stdout_truncated),
    stderr_truncated: results.some(({ stderr_truncated }) => stderr_truncated),
    commands: results.map(({ command }) => command),
    phases: results.map(
      ({
        phase,
        ok,
        error_code: errorCode,
        exit_code: exitCode,
        signal,
        duration_ms: durationMs,
      }) => ({
        phase,
        ok,
        error_code: errorCode,
        exit_code: exitCode,
        signal,
        duration_ms: durationMs,
      }),
    ),
  };
}

function exactKeys(input, allowed, required = allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  return (
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => keys.includes(key))
  );
}

function validateToolInput(toolName, input) {
  switch (toolName) {
    case "list_files":
    case "get_diff":
      return exactKeys(input, [], []);
    case "search_text":
      return exactKeys(input, ["query"]);
    case "read_file":
      return exactKeys(input, ["path"]);
    case "run_tests":
      return exactKeys(input, ["command_id"]);
    case "apply_patch":
      return (
        (exactKeys(input, ["path", "expected_sha256", "replacements"]) &&
          Array.isArray(input.replacements) &&
          input.replacements.every((replacement) =>
            exactKeys(replacement, ["old", "new"]),
          )) ||
        (exactKeys(input, ["path", "expected_sha256", "create_content"]) &&
          input.expected_sha256 === null &&
          typeof input.create_content === "string")
      );
    default:
      return false;
  }
}

function normalizedResult(result, durationMs) {
  return {
    ok: result.ok ?? true,
    error_code: result.error_code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exit_code: result.exit_code ?? null,
    duration_ms: result.duration_ms ?? durationMs,
    ...result,
  };
}

function errorCode(error) {
  if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  return /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(error.message)?.[1] ?? "TOOL_ERROR";
}

async function dispatchTool(context, toolName, input, options) {
  switch (toolName) {
    case "list_files":
      return listFiles(context);
    case "search_text":
      return searchText(context, input);
    case "read_file":
      return readVisibleFile(context, input);
    case "apply_patch":
      return applyStructuredPatch(context, input);
    case "run_tests":
      return runTests(context, input, options);
    case "get_diff":
      return getDiff(context);
    default:
      throw new Error(`TOOL_NOT_ALLOWLISTED: ${toolName}`);
  }
}

export async function executeTool(context, toolName, input, options = {}) {
  const started = process.hrtime.bigint();
  if (!validateToolInput(toolName, input)) {
    return normalizedResult(
      {
        ok: false,
        error_code:
          [
            "list_files",
            "search_text",
            "read_file",
            "apply_patch",
            "run_tests",
            "get_diff",
          ].includes(toolName)
            ? "INVALID_TOOL_ARGUMENTS"
            : "TOOL_NOT_ALLOWLISTED",
        stderr: "Tool arguments did not match the advertised schema.",
      },
      0,
    );
  }
  try {
    const result = await dispatchTool(context, toolName, input, options);
    return normalizedResult(
      result,
      Number(process.hrtime.bigint() - started) / 1e6,
    );
  } catch (error) {
    return normalizedResult(
      {
        ok: false,
        error_code: errorCode(error),
        stderr: error.message,
      },
      Number(process.hrtime.bigint() - started) / 1e6,
    );
  }
}
