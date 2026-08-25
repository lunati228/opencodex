/**
 * Headless control for the managed local runtime (llama.cpp + the local model).
 *
 * These endpoints were GUI-only, which upstream's `cli-headless-parity` gate correctly flags:
 * a headless operator could start the proxy but had no way to see, size, or stop the engine
 * that costs ~28 GB and both GPUs. `ocx local-runtime` closes that gap.
 */
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  type RuntimeApiDeps,
} from "./runtime-api";
import { autoCompactLimitFor } from "../codex/catalog/parsing";
import { qwenContextVariantForContext } from "../local-runtime/context-tiers";

const USAGE = `Usage:
  ocx local-runtime [status] [--json]
  ocx local-runtime start [--json]
  ocx local-runtime stop [--json]
  ocx local-runtime context <tokens> [--json]
  ocx local-runtime autostart <on|off> [--json]`;

interface RuntimeStatus {
  state?: string;
  revision?: number;
  requested?: { profileId?: string; nCtx?: number; reasoningEffort?: string };
  effective?: { profileId?: string; nCtx?: number; model?: string };
  contextConstraints?: { min?: number; max?: number; step?: number };
  contextCheckpoints?: number[];
  controlEnabled?: boolean;
}

function selectedProfileId(status: RuntimeStatus): string | undefined {
  return status.requested?.profileId ?? status.effective?.profileId;
}

function localRuntimeAutoCompactLimit(profileId: string | undefined, nCtx: number): number {
  if (profileId === "qwen38-27b-q6kl") {
    return qwenContextVariantForContext(nCtx)?.autoCompactTokenLimit
      ?? autoCompactLimitFor(nCtx);
  }
  return autoCompactLimitFor(nCtx);
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<RuntimeStatus>("/api/local-runtime/status", {}, deps);
  const nCtx = result.effective?.nCtx ?? result.requested?.nCtx;
  const compactAt = nCtx === undefined
    ? undefined
    : localRuntimeAutoCompactLimit(selectedProfileId(result), nCtx);
  printData(result, wantsJson, [
    `state    ${result.state ?? "unknown"}`,
    `model    ${result.effective?.model ?? "(not loaded)"}`,
    `profile  ${result.effective?.profileId ?? result.requested?.profileId ?? "-"}`,
    // The window drives auto_compact_token_limit (85.5% of it), so show both — a resize that
    // does not move the compaction point is the failure this command exists to make visible.
    `context  ${nCtx ?? "-"}${compactAt !== undefined ? ` (compacts at ${compactAt})` : ""}`,
  ]);
}

async function simplePost(path: string, argv: string[], done: string, deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(path, { method: "POST" }, deps);
  printData(result, wantsJson, [done]);
}

async function context(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const raw = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!raw) throw new CliUsageError("context size in tokens is required", USAGE);
  const nCtx = Number(raw);
  if (!Number.isInteger(nCtx) || nCtx <= 0) throw new CliUsageError(`context must be a positive integer: ${raw}`, USAGE);
  rejectArgs(args, USAGE);

  // apply is a compare-and-swap against the supervisor revision, and it needs the profile id,
  // so read current state rather than making the caller supply either.
  const current = await runtimeRequest<RuntimeStatus>("/api/local-runtime/status", {}, deps);
  const constraints = current.contextConstraints;
  if (constraints?.min !== undefined && nCtx < constraints.min) {
    throw new CliUsageError(`context ${nCtx} is below this profile's minimum ${constraints.min}`, USAGE);
  }
  if (constraints?.max !== undefined && nCtx > constraints.max) {
    throw new CliUsageError(`context ${nCtx} is above this profile's maximum ${constraints.max}`, USAGE);
  }
  if (
    constraints?.step
    && constraints.min !== undefined
    && (nCtx - constraints.min) % constraints.step !== 0
  ) {
    throw new CliUsageError(`context ${nCtx} is not a multiple of this profile's step ${constraints.step}`, USAGE);
  }
  if (
    Array.isArray(current.contextCheckpoints)
    && current.contextCheckpoints.length > 0
    && !current.contextCheckpoints.includes(nCtx)
  ) {
    throw new CliUsageError(
      `context ${nCtx} is not one of this profile's fixed choices: ${current.contextCheckpoints.join(", ")}`,
      USAGE,
    );
  }
  const profileId = selectedProfileId(current);
  if (!profileId) throw new CliUsageError("no local runtime profile is selected", USAGE);

  const effort = current.requested?.reasoningEffort;
  const result = await runtimeRequest("/api/local-runtime/apply", {
    method: "POST",
    body: JSON.stringify({
      profileId,
      nCtx,
      expectedRevision: current.revision,
      ...(effort ? { reasoningEffort: effort } : {}),
    }),
  }, deps);
  printData(result, wantsJson, [
    `Context set to ${nCtx} (compacts at ${localRuntimeAutoCompactLimit(profileId, nCtx)}).`,
  ]);
}

async function autostart(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const value = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (value !== "on" && value !== "off") throw new CliUsageError("autostart takes on or off", USAGE);
  rejectArgs(args, USAGE);
  const enabled = value === "on";
  const result = await runtimeRequest("/api/local-runtime/autostart", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  }, deps);
  printData(result, wantsJson, [
    enabled
      ? "Autostart on: the model loads when the proxy starts."
      : "Autostart off: the model loads on demand after the first message.",
  ]);
}

export async function handleLocalRuntimeCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    // A leading flag means the caller omitted the subcommand (`ocx local-runtime --json`), so
    // it belongs to the default one rather than being read as a subcommand name.
    const bare = argv[0] === undefined || argv[0].startsWith("-");
    const sub = bare ? "status" : argv[0];
    const rest = bare ? argv : argv.slice(1);
    if (sub === "status") await status(rest, deps);
    else if (sub === "start") await simplePost("/api/local-runtime/start", rest, "Local runtime starting.", deps);
    else if (sub === "stop") await simplePost("/api/local-runtime/stop", rest, "Local runtime stopped.", deps);
    else if (sub === "enable") await simplePost("/api/local-runtime/enable", rest, "Local runtime control enabled.", deps);
    else if (sub === "context") await context(rest, deps);
    else if (sub === "autostart") await autostart(rest, deps);
    else throw new CliUsageError(`unknown local-runtime command ${sub}`, USAGE);
  });
}

export const LOCAL_RUNTIME_USAGE = USAGE;
