import { spawn } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { buildAllowedEnvironment } from "./environment.mjs";
import { executableIdentity } from "./canonical.mjs";

function taskkillPath(environment) {
  const configuredRoot =
    Object.entries(environment).find(
      ([name]) => name.toUpperCase() === "SYSTEMROOT",
    )?.[1] ?? "C:\\Windows";
  const normalizedRoot = path.win32.normalize(configuredRoot);
  if (
    !path.win32.isAbsolute(configuredRoot) ||
    normalizedRoot.toLowerCase() !== configuredRoot.toLowerCase()
  ) {
    return null;
  }
  return path.win32.join(normalizedRoot, "System32", "taskkill.exe");
}

async function waitForChildBounded(child, graceMs) {
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("error", finish);
    child.once("close", finish);
    timer = setTimeout(finish, graceMs);
  });
}

async function terminateProcessTree(
  child,
  environment,
  {
    platform,
    spawnImpl,
    terminationGraceMs,
  },
) {
  if (platform === "win32") {
    const taskkill = taskkillPath(environment);
    let killer;
    if (taskkill) {
      try {
        killer = spawnImpl(
          taskkill,
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
            env: environment,
          },
        );
        await waitForChildBounded(killer, terminationGraceMs);
      } catch {
        // Direct child termination below remains mandatory.
      } finally {
        if (killer?.exitCode === null) {
          try {
            killer.kill();
          } catch {
            // The direct child fallback still runs.
          }
        }
      }
    }
    try {
      child.kill();
    } catch {
      // Timeout completion remains bounded even if the OS refuses termination.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Direct child termination below remains mandatory.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Timeout completion remains bounded even if the OS refuses termination.
    }
  }
}

export async function spawnReviewedCommand(
  request,
  {
    sourceEnvironment = process.env,
    spawnImpl = spawn,
    platform = process.platform,
    terminationGraceMs = 1_000,
  } = {},
) {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.executable !== "string" ||
    !Array.isArray(request.argv) ||
    typeof request.cwd !== "string" ||
    !Number.isSafeInteger(request.timeoutMs) ||
    typeof request.executableIdentitySha256 !== "string"
  ) {
    throw new Error("parsed reviewed request is invalid");
  }
  if (
    typeof spawnImpl !== "function" ||
    !["win32", "linux", "darwin", "freebsd", "openbsd", "aix", "sunos"].includes(
      platform,
    ) ||
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    terminationGraceMs > 10_000
  ) {
    throw new Error("executor termination policy is invalid");
  }
  const environment = buildAllowedEnvironment(sourceEnvironment);
  const canonicalCwd = await realpath(request.cwd);
  if (canonicalCwd !== request.cwd) {
    throw new Error("reviewed cwd identity changed before spawn");
  }
  const identity = await executableIdentity(request.executable);
  if (
    identity.canonicalPath !== request.executable ||
    identity.sha256 !== request.executableIdentitySha256
  ) {
    throw new Error("reviewed executable identity changed before spawn");
  }
  const child = spawnImpl(request.executable, request.argv, {
    cwd: canonicalCwd,
    shell: false,
    detached: platform !== "win32",
    windowsHide: true,
    stdio: "ignore",
    env: environment,
  });
  let timer;
  let timedOut = false;
  const exitCode = await new Promise((resolve, reject) => {
    let settled = false;
    const complete = (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    };
    child.once("error", (error) => {
      if (timedOut) {
        complete(child.exitCode ?? 1);
        return;
      }
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", complete);
    timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, environment, {
        platform,
        spawnImpl,
        terminationGraceMs,
      }).then(
        () => complete(child.exitCode ?? 1),
        () => complete(child.exitCode ?? 1),
      );
    }, request.timeoutMs);
  }).finally(() => clearTimeout(timer));
  return { exitCode, timedOut };
}
