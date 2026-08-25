import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-cli.mjs");

export function shellQuoteArgument(
  argument,
  { platform = process.platform } = {},
) {
  if (
    typeof argument !== "string" ||
    argument.includes("\0") ||
    /[\r\n]/.test(argument)
  ) {
    throw new Error("hook argument is invalid");
  }
  if (platform !== "win32") {
    return `'${argument.replaceAll("'", `'"'"'`)}'`;
  }
  if (/[%!^&|<>"]/.test(argument)) {
    throw new Error("hook argument is invalid");
  }
  return `"${argument}"`;
}

export async function createTemporaryReviewerWorkspace({
  baseDirectory,
  nodeExecutable,
}) {
  const canonicalNodeExecutable = await realpath(nodeExecutable);
  const nodeStat = await lstat(canonicalNodeExecutable);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink()) {
    throw new Error("hook Node executable must be a regular file");
  }
  const workspace = await mkdtemp(
    path.join(path.resolve(baseDirectory), ".external-reviewer-"),
  );
  const hooksDirectory = path.join(workspace, ".agents");
  await mkdir(hooksDirectory, { recursive: true });
  const command = [
    shellQuoteArgument(canonicalNodeExecutable),
    shellQuoteArgument(HOOK_CLI),
    "deny-reviewer-tools",
  ].join(" ");
  const hooks = {
    "external-reviewer-no-tools": {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command, timeout: 5 }],
        },
      ],
    },
  };
  await writeFile(
    path.join(hooksDirectory, "hooks.json"),
    JSON.stringify(hooks),
    { encoding: "utf8", flag: "wx" },
  );
  return workspace;
}
