import { win32 } from "node:path";
import type {
  LocalRuntimeProfileId,
  LocalRuntimeReasoningEffort,
  OcxProviderConfig,
} from "../types";
import type { PrivateLocalRuntimeProfile } from "./private-profile";
import {
  QWEN_CONTEXT_VARIANTS,
  QWEN_DEFAULT_CONTEXT,
  qwenContextVariantModelId,
} from "./context-tiers";

export type { LocalRuntimeProfileId, LocalRuntimeReasoningEffort };

/** Public, portable metadata for managed local runtimes. Machine-specific
 * paths, artifact identities, placement flags, and measurements live only in
 * the ignored private profile loaded by `private-profile.ts`.
 */

/**
 * Qwen receives llama.cpp's native `--reasoning-effort` values so its embedded
 * official template remains authoritative. `off` remains a valid local-runtime
 * control setting; Codex picker rows publish only the three actual effort rungs.
 */
export const LOCAL_RUNTIME_REASONING_EFFORTS: readonly LocalRuntimeReasoningEffort[] =
  ["off", "low", "medium", "xhigh"] as const;

export const LOCAL_RUNTIME_HOST = "127.0.0.1";
export const LOCAL_RUNTIME_PORT = 8080;

export interface LocalRuntimeContextConstraints {
  min: number;
  max: number;
  step: number;
}

export interface LocalRuntimeProfile {
  id: LocalRuntimeProfileId;
  /** Provider key this profile projects into the config. */
  providerId: string;
  /** `--alias` the server advertises on `/v1/models`. */
  modelId: string;
  /** Short human label for the profile picker. */
  label: string;
  context: LocalRuntimeContextConstraints;
  /** Optional exact allowlist when the profile intentionally exposes a sparse grid. */
  contextCheckpoints?: readonly number[];
  defaultContext: number;
  defaultReasoningEffort: LocalRuntimeReasoningEffort;
  /** Exact runtime-supported values, including the explicit no-reasoning mode. */
  reasoningEfforts: readonly LocalRuntimeReasoningEffort[];
}

function reasoningArgs(effort: LocalRuntimeReasoningEffort): string[] {
  if (effort === "off") return ["--reasoning", "off"];
  return ["--reasoning", "auto", "--reasoning-effort", effort];
}

/**
 * Huihui Qwen3.8 27B abliterated Q6_K_L -- the default.
 *
 * Only model-level behavior belongs in the public profile. The accepted local
 * engine build and machine placement are intentionally private.
 */
export const QWEN_PROFILE: LocalRuntimeProfile = {
  id: "qwen38-27b-q6kl",
  providerId: "qwen-local",
  modelId: "huihui-qwen3.8-27b-abliterated-q6-k-l",
  label: "Huihui Qwen3.8 27B Q6_K_L (vision + MTP)",
  context: { min: 16_384, max: 196_608, step: 16_384 },
  contextCheckpoints: QWEN_CONTEXT_VARIANTS.map(variant => variant.contextWindow),
  defaultContext: QWEN_DEFAULT_CONTEXT,
  defaultReasoningEffort: "xhigh",
  reasoningEfforts: LOCAL_RUNTIME_REASONING_EFFORTS,
};

export const LOCAL_RUNTIME_PROFILES: readonly LocalRuntimeProfile[] = [
  QWEN_PROFILE,
] as const;

/** Huihui Qwen3.8 is the only managed local profile. */
export const DEFAULT_LOCAL_RUNTIME_PROFILE = QWEN_PROFILE;

export function isLocalRuntimeProfileId(
  value: unknown,
): value is LocalRuntimeProfileId {
  return LOCAL_RUNTIME_PROFILES.some(profile => profile.id === value);
}

export function getLocalRuntimeProfile(
  id: LocalRuntimeProfileId,
): LocalRuntimeProfile {
  const profile = LOCAL_RUNTIME_PROFILES.find(entry => entry.id === id);
  if (!profile) throw new Error("LOCAL_RUNTIME_PROFILE_INVALID");
  return profile;
}

export function isLocalRuntimeReasoningEffort(
  value: unknown,
): value is LocalRuntimeReasoningEffort {
  return LOCAL_RUNTIME_REASONING_EFFORTS.includes(
    value as LocalRuntimeReasoningEffort,
  );
}

/* ------------------------------------------------------------------------ *
 * Default-profile aliases.
 *
 * Consumers use these singular aliases because Qwen is the only managed local
 * profile.
 * ------------------------------------------------------------------------ */
export const LOCAL_RUNTIME_PROVIDER_ID = DEFAULT_LOCAL_RUNTIME_PROFILE.providerId;
export const LOCAL_RUNTIME_PROFILE_ID = DEFAULT_LOCAL_RUNTIME_PROFILE.id;
export const LOCAL_RUNTIME_MODEL_ID = DEFAULT_LOCAL_RUNTIME_PROFILE.modelId;
export const LOCAL_RUNTIME_MIN_CONTEXT = DEFAULT_LOCAL_RUNTIME_PROFILE.context.min;
export const LOCAL_RUNTIME_MAX_CONTEXT = DEFAULT_LOCAL_RUNTIME_PROFILE.context.max;
export const LOCAL_RUNTIME_CONTEXT_STEP = DEFAULT_LOCAL_RUNTIME_PROFILE.context.step;

export interface LocalRuntimeCandidate {
  profileId: LocalRuntimeProfileId;
  nCtx: number;
  reasoningEffort: LocalRuntimeReasoningEffort;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor() {
    super("Managed local runtime is not ready");
    this.name = "LocalRuntimeUnavailableError";
  }
}

export function isAllowedLocalRuntimeContext(
  nCtx: number,
  context: LocalRuntimeContextConstraints,
): boolean {
  return Number.isSafeInteger(nCtx)
    && nCtx >= context.min
    && nCtx <= context.max
    && (nCtx - context.min) % context.step === 0;
}

/**
 * `reasoningEffort` is optional on input so callers predating the picker keep
 * working; it resolves to the profile's own default. Retired Qwen picker
 * values normalize at this boundary so they cannot reach llama.cpp verbatim.
 */
export function validateLocalRuntimeCandidate(
  value: { profileId: string; nCtx: number; reasoningEffort?: string },
): LocalRuntimeCandidate {
  if (!isLocalRuntimeProfileId(value.profileId)) {
    throw new Error("LOCAL_RUNTIME_PROFILE_INVALID");
  }
  const profile = getLocalRuntimeProfile(value.profileId);
  if (
    !isAllowedLocalRuntimeContext(value.nCtx, profile.context)
    || (profile.contextCheckpoints !== undefined
      && !profile.contextCheckpoints.includes(value.nCtx))
  ) {
    throw new Error("LOCAL_RUNTIME_CONTEXT_INVALID");
  }
  const requestedEffort = value.reasoningEffort ?? profile.defaultReasoningEffort;
  const effort = profile.id === QWEN_PROFILE.id
    && (requestedEffort === "high" || requestedEffort === "max")
    ? "xhigh"
    : requestedEffort;
  if (
    !isLocalRuntimeReasoningEffort(effort)
    || !profile.reasoningEfforts.includes(effort)
  ) {
    throw new Error("LOCAL_RUNTIME_REASONING_INVALID");
  }
  return { profileId: profile.id, nCtx: value.nCtx, reasoningEffort: effort };
}

export function buildLocalRuntimeArgs(
  candidate: { profileId: string; nCtx: number; reasoningEffort?: string },
  privateProfile: PrivateLocalRuntimeProfile,
): string[] {
  const validated = validateLocalRuntimeCandidate(candidate);
  const profile = getLocalRuntimeProfile(validated.profileId);
  if (privateProfile.profileId !== profile.id) {
    throw new Error("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
  }
  return [
    "--model", privateProfile.modelPath,
    "--mmproj", privateProfile.projectorPath,
    "--host", LOCAL_RUNTIME_HOST,
    "--port", String(LOCAL_RUNTIME_PORT),
    "--alias", profile.modelId,
    "--ctx-size", String(validated.nCtx),
    "--n-predict", String(privateProfile.serverPredictionLimit),
    "--parallel", "1",
    ...privateProfile.launchArgs,
    ...reasoningArgs(validated.reasoningEffort),
  ];
}

export function buildLocalRuntimeEnvironment(
  privateProfile: PrivateLocalRuntimeProfile,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!isLocalRuntimeProfileId(privateProfile.profileId)) {
    throw new Error("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = source[key];
    if (value) env[key] = value;
  }
  const systemRoot = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  env.PATH = [
    privateProfile.releaseRoot,
    win32.join(systemRoot, "System32"),
  ].join(";");
  for (const [key, value] of Object.entries(privateProfile.environment)) {
    env[key] = value;
  }
  return env;
}

export function managedLocalProviderProjection(
  nCtx: number,
  profileId: LocalRuntimeProfileId = DEFAULT_LOCAL_RUNTIME_PROFILE.id,
): OcxProviderConfig {
  const profile = getLocalRuntimeProfile(profileId);
  validateLocalRuntimeCandidate({ profileId, nCtx });
  const modelIds = QWEN_CONTEXT_VARIANTS.map(variant => (
    qwenContextVariantModelId(profile.modelId, variant.contextWindow)
  ));
  const modelContextWindows = Object.fromEntries(QWEN_CONTEXT_VARIANTS.map(variant => [
      qwenContextVariantModelId(profile.modelId, variant.contextWindow),
      variant.contextWindow,
  ]));
  const defaultModel = qwenContextVariantModelId(profile.modelId, nCtx);
  const modelReasoningEfforts = Object.fromEntries(
    modelIds.map(modelId => [
      modelId,
      profile.reasoningEfforts.filter(effort => effort !== "off"),
    ]),
  );
  const modelDefaultReasoningEfforts = Object.fromEntries(
    modelIds.map(modelId => [modelId, profile.defaultReasoningEffort]),
  );
  const modelReasoningEffortMap = Object.fromEntries(
    modelIds.map(modelId => [modelId, { high: "xhigh", max: "xhigh" }]),
  );
  return {
    adapter: "openai-chat",
    baseUrl: `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}/v1`,
    allowPrivateNetwork: true,
    authMode: "local",
    keyOptional: true,
    freeTier: true,
    defaultModel,
    models: modelIds,
    selectedModels: modelIds,
    liveModels: false,
    contextWindow: nCtx,
    modelContextWindows,
    modelInputModalities: Object.fromEntries(
      modelIds.map(modelId => [modelId, ["text", "image"]]),
    ),
    modelSuffixBracketStrip: true,
    // Qwen's embedded template accepts low, medium, and xhigh. The catalog
    // publishes exactly that ladder; stale high/max requests and Codex's global
    // ultra->max boundary are translated here instead of becoming picker rungs.
    modelReasoningEfforts,
    modelDefaultReasoningEfforts,
    modelReasoningEffortMap,
    localRuntimeProfileId: profile.id,
  };
}

/**
 * Fields added to the projection after a config was first written. A stored projection from an
 * older build legitimately lacks them, and comparing only against the CURRENT shape would
 * classify it as user-owned — which is exactly the P46 dead end: `controlled()` flips false and
 * every control answers 409 "collision", including the one that would repair it. Recognising the
 * legacy shape lets `withManagedProviderProjections` rewrite it forward on load instead.
 */
const PROJECTION_FIELDS_ADDED_LATER = [
  "modelReasoningEfforts",
  "modelDefaultReasoningEfforts",
  "modelReasoningEffortMap",
] as const;

/** Exact provider projection emitted by the retired 256K/medium Qwen profile. */
function legacyQwen256ProviderProjection(nCtx: number): OcxProviderConfig | undefined {
  if (nCtx !== 131_072 && nCtx !== 262_144) return undefined;
  const profile = QWEN_PROFILE;
  const modelIds = [`${profile.modelId}[128K]`, profile.modelId];
  const defaultModel = nCtx === 262_144 ? profile.modelId : modelIds[0]!;
  return {
    adapter: "openai-chat",
    baseUrl: `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_PORT}/v1`,
    allowPrivateNetwork: true,
    authMode: "local",
    keyOptional: true,
    freeTier: true,
    defaultModel,
    models: modelIds,
    selectedModels: modelIds,
    liveModels: false,
    contextWindow: nCtx,
    modelContextWindows: {
      [modelIds[0]!]: 131_072,
      [modelIds[1]!]: 262_144,
    },
    defaultMaxOutputTokens: 8192,
    modelMaxOutputTokens: Object.fromEntries(modelIds.map(modelId => [modelId, 8192])),
    modelInputModalities: Object.fromEntries(
      modelIds.map(modelId => [modelId, ["text", "image"]]),
    ),
    modelSuffixBracketStrip: true,
    modelReasoningEfforts: Object.fromEntries(
      modelIds.map(modelId => [modelId, ["low", "medium", "xhigh"]]),
    ),
    modelDefaultReasoningEfforts: Object.fromEntries(
      modelIds.map(modelId => [modelId, "medium"]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      modelIds.map(modelId => [modelId, { high: "xhigh", max: "xhigh" }]),
    ),
    localRuntimeProfileId: profile.id,
  };
}

function matchesManagedProjectionHistory(
  stored: string,
  projection: OcxProviderConfig,
): boolean {
  if (stored === JSON.stringify(projection)) return true;
  // Deleting a field preserves the historical key order of every remaining field.
  const legacyFieldSets: readonly (readonly string[])[] = [
    PROJECTION_FIELDS_ADDED_LATER,
    ["modelDefaultReasoningEfforts", "modelReasoningEffortMap"],
  ];
  return legacyFieldSets.some(fields => {
    const legacy: Record<string, unknown> = { ...projection };
    for (const field of fields) delete legacy[field];
    return stored === JSON.stringify(legacy);
  });
}

export function isManagedLocalProviderProjection(
  name: string,
  provider: OcxProviderConfig,
): boolean {
  const profile = LOCAL_RUNTIME_PROFILES.find(
    entry => entry.id === provider.localRuntimeProfileId,
  );
  if (!profile || name !== profile.providerId || provider.apiKey !== undefined) {
    return false;
  }
  const nCtx = provider.contextWindow;
  if (typeof nCtx !== "number") return false;
  try {
    const stored = JSON.stringify(provider);
    let current: OcxProviderConfig | undefined;
    try {
      current = managedLocalProviderProjection(nCtx, profile.id);
    } catch {
      current = undefined;
    }
    return [current, legacyQwen256ProviderProjection(nCtx)]
      .filter((candidate): candidate is OcxProviderConfig => candidate !== undefined)
      .some(candidate => matchesManagedProjectionHistory(stored, candidate));
  } catch {
    return false;
  }
}

/**
 * Cloud providers normally return response headers well within 200 seconds.
 * A managed local runtime does not: llama.cpp finishes prompt evaluation before
 * sending the first response byte, and evaluating a near-192K prompt can
 * legitimately exceed that cloud-oriented deadline on this host. Keep the
 * exception finite and identity-bound, and always preserve an operator override.
 */
export function effectiveLocalRuntimeConnectTimeoutMs(
  configured: number | undefined,
  providerName: string,
  provider: OcxProviderConfig,
): number {
  if (configured !== undefined) return configured;
  return isManagedLocalProviderProjection(providerName, provider)
    ? 900_000
    : 200_000;
}
