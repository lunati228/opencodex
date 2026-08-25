/**
 * Platform plumbing for the Codex companion.
 *
 * Kept apart from `companion.ts` on purpose: that file is the pure decision, this
 * one is the process/OS half. Splitting them is what lets the interesting
 * behaviour (linger, ownership) be tested without spawning anything.
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { requestBoundSystemRestart } from "../cli/system-restart-client";
import {
  MEMORY_DRAIN_RESTART_MS,
  REPLACEMENT_READY_TIMEOUT_MS,
} from "../lib/system-restart-contract";
import { findLiveProxy } from "../server/proxy-liveness";
import { stopProxyGracefully } from "../lib/process-control";
import {
  CODEX_COMPANION_LIFECYCLE_OWNER,
  withCompanionLifecycleOwner,
} from "./companion-ownership";
import {
  DEFAULT_CODEX_IMAGE_NAMES,
  runCodexCompanion,
  type CompanionDeps,
} from "./companion";
import type { LiveProxy } from "../server/proxy-liveness";

/** The proxy binds loopback only; the companion must never reach off-box. */
const LOCAL_PROXY_HOST = "127.0.0.1";
const COMPANION_RESTART_OBSERVE_MS =
  MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS + 15_000;

function systemRoot(): string {
  return process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
}

function cliEntry(): { runtime: string; cli: string } {
  // Mirrors service.ts: the CLI entry sits next to this file's package root.
  return { runtime: process.execPath, cli: join(import.meta.dir, "..", "cli", "index.ts") };
}

export type CompanionProcessQueryKind = "tasklist" | "powershell";
export interface CompanionProcessQueryResult {
  success: boolean;
  stdout: string;
}
export type CompanionProcessQueryRunner = (
  kind: CompanionProcessQueryKind,
  imageName?: string,
) => CompanionProcessQueryResult;

function controlledWindowsEnvironment(): NodeJS.ProcessEnv {
  const root = systemRoot();
  const childEnv: NodeJS.ProcessEnv = {
    SystemRoot: root,
    SYSTEMROOT: root,
    WINDIR: root,
  };
  for (const key of ["TEMP", "TMP", "ComSpec", "COMSPEC"] as const) {
    const value = process.env[key];
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

const PROCESS_NAMES_SCRIPT = String.raw`[Diagnostics.Process]::GetProcesses() | ForEach-Object { try { [Console]::Out.WriteLine($_.ProcessName + '.exe' + [char]9 + $_.Id) } catch {} finally { $_.Dispose() } }`;

function defaultProcessQueryRunner(
  kind: CompanionProcessQueryKind,
  imageName?: string,
): CompanionProcessQueryResult {
  if (kind === "tasklist") {
    const result = spawnSync(`${systemRoot()}\\System32\\tasklist.exe`, [
      "/FI", `IMAGENAME eq ${imageName ?? ""}`,
      "/NH", "/FO", "CSV",
    ], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      success: result.error === undefined && result.status === 0,
      stdout: result.stdout ?? "",
    };
  }
  const result = spawnSync(
    `${systemRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      PROCESS_NAMES_SCRIPT,
    ],
    {
      encoding: "utf8",
      env: controlledWindowsEnvironment(),
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return {
    success: result.error === undefined && result.status === 0,
    stdout: result.stdout ?? "",
  };
}

let processQueryRunner: CompanionProcessQueryRunner = defaultProcessQueryRunner;

/** Test seam for tasklist-denied and fallback behavior. */
export function setCompanionProcessQueryRunnerForTests(
  runner: CompanionProcessQueryRunner | null,
): void {
  processQueryRunner = runner ?? defaultProcessQueryRunner;
}

export interface CodexProcessIdentity {
  imageName: string;
  pid: number;
}

function stableProcessIdentities(processes: readonly CodexProcessIdentity[]): CodexProcessIdentity[] {
  const unique = new Map<string, CodexProcessIdentity>();
  for (const process of processes) {
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0) continue;
    const imageName = process.imageName.trim();
    if (!imageName) continue;
    unique.set(`${imageName.toLowerCase()}\u0000${process.pid}`, { imageName, pid: process.pid });
  }
  return [...unique.values()].sort((left, right) =>
    left.imageName.localeCompare(right.imageName, "en", { sensitivity: "base" })
    || left.pid - right.pid);
}

function requestedImageMap(imageNames: readonly string[]): Map<string, string> {
  return new Map(imageNames.map(imageName => [imageName.toLowerCase(), imageName]));
}

function parseTasklistProcesses(
  stdout: string,
  requested: ReadonlyMap<string, string>,
): CodexProcessIdentity[] {
  const found: CodexProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // /FO CSV fixes image name and PID as its first two quoted fields. Later
    // localized columns may contain commas, so they are intentionally ignored.
    const match = /^"([^"]+)","([1-9]\d*)"(?:,|$)/.exec(line.trim());
    if (!match) continue;
    const imageName = requested.get(match[1]!.toLowerCase());
    const pid = Number(match[2]);
    if (imageName && Number.isSafeInteger(pid)) found.push({ imageName, pid });
  }
  return found;
}

function parsePowerShellProcesses(
  stdout: string,
  requested: ReadonlyMap<string, string>,
): CodexProcessIdentity[] {
  const found: CodexProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.lastIndexOf("\t");
    if (separator <= 0) continue;
    const imageName = requested.get(line.slice(0, separator).trim().toLowerCase());
    const pidText = line.slice(separator + 1).trim();
    if (!imageName || !/^[1-9]\d*$/.test(pidText)) continue;
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid)) found.push({ imageName, pid });
  }
  return found;
}

/**
 * Which Codex images are live right now.
 *
 * `tasklist` is the cheap primary probe. Some Windows policies return access
 * denied even for same-user processes; only that failure path pays for one
 * fixed, non-interactive PowerShell process-name query.
 */
export function runningCodexProcesses(
  imageNames: readonly string[] = DEFAULT_CODEX_IMAGE_NAMES,
): CodexProcessIdentity[] {
  if (process.platform !== "win32") return [];
  const requested = requestedImageMap(imageNames);
  const found: CodexProcessIdentity[] = [];
  for (const image of imageNames) {
    const result = processQueryRunner("tasklist", image);
    // tasklist exits 0 with a human "no tasks" line when nothing matches, so the
    // exit code proves nothing — the image name appearing in CSV output does.
    found.push(...parseTasklistProcesses(result.stdout ?? "", requested));
    if (!result.success || /^\s*ERROR:/im.test(result.stdout)) {
      // Some Windows policies deny tasklist while the ordinary current-user
      // process API remains available. The fallback script is fixed: image
      // names are compared locally and are never interpolated into PowerShell.
      const fallback = processQueryRunner("powershell");
      if (!fallback.success) {
        throw new Error("Codex process observation unavailable");
      }
      return stableProcessIdentities(parsePowerShellProcesses(fallback.stdout, requested));
    }
  }
  return stableProcessIdentities(found);
}

export function runningCodexImages(
  imageNames: readonly string[] = DEFAULT_CODEX_IMAGE_NAMES,
): string[] {
  const live = new Set(
    runningCodexProcesses(imageNames).map(process => process.imageName.toLowerCase()),
  );
  return imageNames.filter(imageName => live.has(imageName.toLowerCase()));
}

export interface CompanionProxyRestartIo {
  findLive?: typeof findLiveProxy;
  requestRestart?: typeof requestBoundSystemRestart;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function restartCompanionProxy(
  io: CompanionProxyRestartIo = {},
): Promise<void | "busy"> {
  const findLive = io.findLive ?? findLiveProxy;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const target = await findLive();
  if (
    !target
    || target.pid === null
    || target.source !== "runtime"
    || target.lifecycleOwner !== CODEX_COMPANION_LIFECYCLE_OWNER
  ) {
    throw new Error("companion-owned restart target is unavailable");
  }

  const deadlineAt = now() + COMPANION_RESTART_OBSERVE_MS;
  const requested = await (io.requestRestart ?? ((live, deadline) =>
    requestBoundSystemRestart(live, deadline, { requireIdle: true })))(target, deadlineAt);
  if (!requested.accepted && !requested.uncertain) {
    if (requested.error instanceof Error && requested.error.message === "restart_request_http_423") return "busy";
    throw requested.error ?? new Error("companion proxy restart was rejected");
  }

  while (now() < deadlineAt) {
    let replacement: LiveProxy | null;
    try {
      replacement = await findLive({ deadlineAt, attempts: 2 });
    } catch {
      replacement = null;
    }
    if (
      replacement
      && replacement.source === "runtime"
      && replacement.pid !== null
      && replacement.pid !== target.pid
      && replacement.port === target.port
      && replacement.lifecycleOwner === CODEX_COMPANION_LIFECYCLE_OWNER
    ) {
      return;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs > 0) await sleep(Math.min(250, remainingMs));
  }
  throw new Error("companion proxy replacement did not become healthy in time");
}

export function buildCompanionDeps(
  imageNames: readonly string[] = DEFAULT_CODEX_IMAGE_NAMES,
  releaseModelOnClose = true,
  stopProxyOnClose = true,
): CompanionDeps {
  const { runtime, cli } = cliEntry();
  let proxyOwnedByCompanion: boolean | undefined;
  return {
    ...(releaseModelOnClose ? {} : { releaseModelOnClose: false }),
    ...(stopProxyOnClose ? {} : { stopProxyOnClose: false }),
    codexIsRunning: async () => runningCodexProcesses(imageNames).length > 0,
    codexProcessIds: async () => runningCodexProcesses(imageNames).map(process => process.pid),
    proxyIsRunning: async () => {
      const live = await findLiveProxy();
      // Runtime metadata is identity checked and therefore authoritative. A
      // configured-port fallback proves liveness only, so preserve the existing
      // in-memory claim until ownership can be observed again.
      proxyOwnedByCompanion = live?.source === "runtime"
        ? live.lifecycleOwner === CODEX_COMPANION_LIFECYCLE_OWNER
        : undefined;
      return live !== null;
    },
    proxyOwnedByCompanion: () => proxyOwnedByCompanion,
    startProxy: async () => {
      // Detached: the proxy must outlive this tick, and `ensure` is the existing
      // idempotent "start it if it is not already up" entry point.
      const child = spawn(runtime, [cli, "ensure"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: withCompanionLifecycleOwner(process.env),
      });
      child.unref();
    },
    restartProxy: restartCompanionProxy,
    releaseModel: async () => {
      // Deliberately the management API and NOT `ocx stop`: `ocx stop` also
      // restores native Codex, stripping the injected openai_base_url. This
      // stops llama-server only and leaves the proxy (and the injection) alone.
      const live = await findLiveProxy();
      if (!live) return; // No proxy means no local runtime to release.
      const response = await fetch(
        `http://${LOCAL_PROXY_HOST}:${live.port}/api/local-runtime/stop`,
        { method: "POST", signal: AbortSignal.timeout(15_000) },
      );
      // 409 "not-running" is success for this purpose: the model is already down.
      if (!response.ok && response.status !== 409) {
        throw new Error(`local-runtime stop returned ${response.status}`);
      }
    },
    stopProxy: async () => {
      // Same reasoning as releaseModel, one step further: stop the PROCESS, never call
      // `ocx stop`. `ocx stop` restores native Codex and strips the injected
      // openai_base_url, so the next launch would silently bypass the proxy entirely.
      // Stopping the pid leaves `~/.codex/config.toml` pointing at the proxy, and the
      // companion starts it again as soon as it sees codex.exe.
      const live = await findLiveProxy();
      if (!live) return; // Already down.
      if (typeof live.pid !== "number") {
        throw new Error("live proxy reported no pid; refusing to guess which process to stop");
      }
      // keepCodexRouting: plain /api/stop calls restoreNativeCodex(), which strips
      // openai_base_url AND model_catalog_json. Doing that on every Codex close meant
      // the next launch read the native catalog with none of the routed rows — the
      // exact outcome this dep's contract forbids.
      await stopProxyGracefully(live.pid, {}, true);
    },
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: message => console.log(`[opencodex companion] ${message}`),
  };
}

async function printStatus(imageNames: readonly string[]): Promise<void> {
  const images = runningCodexImages(imageNames);
  const live = await findLiveProxy();
  console.log(`Watching image names : ${imageNames.join(", ")}`);
  console.log(`Codex running        : ${images.length > 0 ? `yes (${images.join(", ")})` : "no"}`);
  console.log(`Proxy running        : ${live ? `yes (port ${live.port})` : "no"}`);
  if (process.platform === "win32" && images.length === 0) {
    console.log(
      "\nIf Codex IS open right now, its executable is named something else.\n"
      + "Find it with:  tasklist /FO CSV /NH | findstr /I codex\n"
      + "then re-run with:  ocx codex-companion status --images <name.exe>",
    );
  }
}

/** `ocx codex-companion <run|status>` — thin argument handling only. */
export async function codexCompanionCommand(args: string[]): Promise<void> {
  const imagesFlag = args.indexOf("--images");
  const imageNames = imagesFlag >= 0 && args[imagesFlag + 1]
    ? args[imagesFlag + 1].split(",").map(name => name.trim()).filter(Boolean)
    : DEFAULT_CODEX_IMAGE_NAMES;
  // On by default -- see CompanionObservation.releaseModelOnClose / stopProxyOnClose.
  const releaseModelOnClose = !args.includes("--keep-model-loaded");
  const stopProxyOnClose = !args.includes("--keep-proxy-running");

  switch (args[0]) {
    case "run":
      if (process.platform !== "win32") {
        console.error("The Codex companion currently supports Windows only.");
        process.exit(1);
      }
      console.log(
        `[opencodex companion] watching ${imageNames.join(", ")}`
        + (releaseModelOnClose ? " (releases the local model on close)" : " (keeps the local model loaded)")
        + (stopProxyOnClose ? " (stops the proxy on close; Codex routing stays injected)" : " (keeps the proxy running)"),
      );
      await runCodexCompanion(buildCompanionDeps(imageNames, releaseModelOnClose, stopProxyOnClose));
      break;
    case "status":
      await printStatus(imageNames);
      break;
    default:
      console.error(
        "Usage: ocx codex-companion <run|status> [--images codex.exe,...] "
        + "[--keep-model-loaded] [--keep-proxy-running]",
      );
      process.exit(1);
  }
}
