import {
  getManagedLocalRuntimeSupervisor,
  managedLocalRuntimeProviderIsValid,
} from "../../local-runtime/production";
import {
  DEFAULT_LOCAL_RUNTIME_PROFILE,
  LOCAL_RUNTIME_PROFILES,
  getLocalRuntimeProfile,
  managedLocalProviderProjection,
  type LocalRuntimeProfileId,
} from "../../local-runtime/profile";
import { loadPrivateLocalRuntimeProfile } from "../../local-runtime/private-profile";
import { saveConfigPreservingClaudeCode } from "../../config";
import { invalidateCodexModelsCache } from "../../codex/catalog/sync";
import type {
  LocalRuntimeMutationResult,
} from "../../local-runtime/supervisor";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

function mutationStatus(result: LocalRuntimeMutationResult): number {
  if (result.accepted) return 202;
  return result.reason === "invalid-candidate" ? 422 : 409;
}

function controlled(ctx: ManagementContext): boolean {
  return ctx.config.localRuntime?.enabled === true
    && managedLocalRuntimeProviderIsValid(ctx.config);
}

function privateMeasurement(profileId: LocalRuntimeProfileId): {
  measuredTokensPerSecond: number;
  measurementNote: string;
} {
  try {
    const privateProfile = loadPrivateLocalRuntimeProfile(profileId);
    return {
      measuredTokensPerSecond: privateProfile.measuredTokensPerSecond,
      measurementNote: privateProfile.measurementNote,
    };
  } catch {
    return {
      measuredTokensPerSecond: 0,
      measurementNote: "Private runtime measurement is not configured on this machine.",
    };
  }
}

export async function handleLocalRuntimeRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  if (!url.pathname.startsWith("/api/local-runtime/")) return null;
  const supervisor = deps.localRuntimeSupervisor
    ?? getManagedLocalRuntimeSupervisor();

  if (url.pathname === "/api/local-runtime/status" && req.method === "GET") {
    const status = supervisor.status(config);
    // `profileId` and `contextConstraints` remain at the top level for clients
    // written before the profile descriptor was added.
    const activeId = status.requested?.profileId ?? status.effective?.profileId;
    const active = LOCAL_RUNTIME_PROFILES.find(profile => profile.id === activeId)
      ?? DEFAULT_LOCAL_RUNTIME_PROFILE;
    return jsonResponse({
      ...status,
      profileId: active.id,
      contextConstraints: { ...active.context },
      ...(active.contextCheckpoints
        ? { contextCheckpoints: [...active.contextCheckpoints] }
        : {}),
      reasoningEfforts: [...active.reasoningEfforts],
      profiles: LOCAL_RUNTIME_PROFILES.map(profile => ({
        id: profile.id,
        label: profile.label,
        modelId: profile.modelId,
        context: { ...profile.context },
        ...(profile.contextCheckpoints
          ? { contextCheckpoints: [...profile.contextCheckpoints] }
          : {}),
        defaultContext: profile.defaultContext,
        defaultReasoningEffort: profile.defaultReasoningEffort,
        reasoningEfforts: [...profile.reasoningEfforts],
        ...privateMeasurement(profile.id),
      })),
      controlEnabled: controlled(ctx),
    });
  }

  if (url.pathname === "/api/local-runtime/stop" && req.method === "POST") {
    const result = supervisor.requestStop();
    return jsonResponse({
      ...result,
      status: supervisor.status(config),
    }, mutationStatus(result));
  }

  /**
   * Turn the managed runtime on for the first time.
   *
   * This exists because nothing else could. `config.localRuntime` was only ever
   * written by `persistLastKnownGood`, which runs *after* a successful launch --
   * and a launch requires `controlled(ctx)`, which requires
   * `config.localRuntime.enabled`. That is circular, so on a fresh config the
   * feature was unreachable: the profile picker rendered, and every control was
   * disabled forever.
   *
   * Deliberately placed ABOVE the `controlled` gate, since being un-enabled is
   * exactly the state it is here to fix. It writes through
   * `saveConfigPreservingClaudeCode` rather than touching config.json directly.
   */
  if (url.pathname === "/api/local-runtime/enable" && req.method === "POST") {
    let raw: unknown = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      try {
        raw = await req.json();
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
    }
    if (!isPlainRecord(raw)) {
      return jsonResponse({ error: "enable body must be a plain object" }, 400);
    }
    if (Object.keys(raw).some(key => key !== "profileId")) {
      return jsonResponse({ error: "unsupported local runtime field" }, 400);
    }
    const requested = raw.profileId ?? DEFAULT_LOCAL_RUNTIME_PROFILE.id;
    if (
      typeof requested !== "string"
      || !LOCAL_RUNTIME_PROFILES.some(entry => entry.id === requested)
    ) {
      return jsonResponse({ error: "unknown profileId" }, 422);
    }
    const profile = getLocalRuntimeProfile(requested as LocalRuntimeProfileId);
    config.localRuntime = {
      enabled: true,
      // Enabling is not the same as launching. The operator still presses Start,
      // so turning this on can never itself spawn a multi-gigabyte model load.
      autoStart: false,
      profileId: profile.id,
      nCtx: profile.defaultContext,
      reasoningEffort: profile.defaultReasoningEffort,
    };
    // The provider projection is the second half of `controlled()`; writing only
    // the flag would leave the runtime reporting a "collision" instead.
    config.providers[profile.providerId] = managedLocalProviderProjection(
      profile.defaultContext,
      profile.id,
    );
    (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    return jsonResponse({ enabled: true, status: supervisor.status(config) });
  }

  if (!controlled(ctx)) {
    return jsonResponse({
      error: config.localRuntime?.enabled
        ? "managed local provider collision"
        : "managed local runtime is disabled",
      // Names the way out, so a disabled runtime is a recoverable state rather
      // than a dead end with no discoverable next step.
      remedy: "POST /api/local-runtime/enable",
    }, 409);
  }

  if (url.pathname === "/api/local-runtime/start" && req.method === "POST") {
    const result = supervisor.requestStart(config);
    return jsonResponse({
      ...result,
      status: supervisor.status(config),
    }, mutationStatus(result));
  }

  // `enable` deliberately leaves autoStart off — enabling is not launching, and a fresh
  // enable must never itself spawn a multi-gigabyte model load. But an operator who wants
  // "open the client, model is already there" had no way to persist that intent: `apply`
  // rejects the field and nothing else writes it, so server/index.ts's autoStart gate was
  // permanently unreachable. This is that switch, and nothing more — it never starts or
  // stops the runtime, so flipping it on is cheap and reversible until the next boot.
  if (url.pathname === "/api/local-runtime/autostart" && req.method === "PUT") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    // Unknown-key rejection mirrors `enable`/`apply`: a body that smuggles an extra field is a
    // caller bug, and silently ignoring it is how an executable path ends up somewhere it is
    // never read but is assumed to be honoured.
    if (
      !isPlainRecord(raw)
      || typeof raw.enabled !== "boolean"
      || Object.keys(raw).some(key => key !== "enabled")
    ) {
      return jsonResponse({ error: "autostart body must be exactly { enabled: boolean }" }, 400);
    }
    const current = config.localRuntime;
    if (!current) return jsonResponse({ error: "managed local runtime is disabled" }, 409);
    config.localRuntime = { ...current, autoStart: raw.enabled };
    (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    return jsonResponse({ autoStart: raw.enabled, status: supervisor.status(config) });
  }

  if (url.pathname === "/api/local-runtime/apply" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(raw)) {
      return jsonResponse({ error: "local runtime apply body must be a plain object" }, 400);
    }
    const allowed = new Set([
      "profileId",
      "nCtx",
      "expectedRevision",
      "reasoningEffort",
    ]);
    if (Object.keys(raw).some(key => !allowed.has(key))) {
      return jsonResponse({ error: "unsupported local runtime field" }, 400);
    }
    if (
      typeof raw.profileId !== "string"
      || typeof raw.nCtx !== "number"
      || typeof raw.expectedRevision !== "number"
    ) {
      return jsonResponse({
        error: "profileId, nCtx and expectedRevision are required",
      }, 400);
    }
    // Optional so a client predating the picker still applies successfully;
    // the supervisor resolves an absent value to the profile's own default.
    if (raw.reasoningEffort !== undefined && typeof raw.reasoningEffort !== "string") {
      return jsonResponse({ error: "reasoningEffort must be a string" }, 400);
    }
    const result = supervisor.requestApply(config, {
      profileId: raw.profileId,
      nCtx: raw.nCtx,
      expectedRevision: raw.expectedRevision,
      ...(raw.reasoningEffort !== undefined
        ? { reasoningEffort: raw.reasoningEffort }
        : {}),
    });
    // nCtx IS the model's real context window, and the catalog derives both `context_window` and
    // `auto_compact_token_limit` from it. Without this the picker keeps advertising the previous
    // size after a resize, so Codex would compact against a window the engine no longer has.
    if (result.accepted) invalidateCodexModelsCache();
    return jsonResponse({
      ...result,
      status: supervisor.status(config),
    }, mutationStatus(result));
  }

  return null;
}
