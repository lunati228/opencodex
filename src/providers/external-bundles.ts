import { dirname, resolve } from "node:path";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const EXTERNAL_PROVIDER_BUNDLE_REFS = [
  "nvidia-glm-5.2",
  "nvidia-deepseek-v4-pro",
  "nvidia-kimi-k2.6",
] as const;

export type ExternalProviderBundleRef = typeof EXTERNAL_PROVIDER_BUNDLE_REFS[number];
export type ExternalProviderBundleState = "ready" | "configured-unavailable" | "bundle-error";

type Descriptor = {
  ref: ExternalProviderBundleRef;
  filename: string;
  provider: string;
  model: string;
  displayName: string;
  contextWindow?: number;
  routingEligible: boolean;
  unavailableReason?: "upstream-model-not-found";
};

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const EXTERNAL_SECRET_PREFIX = "@opencodex-external/";
const MAX_BUNDLE_BYTES = 64 * 1024;
const MAX_API_KEY_BYTES = 16 * 1024;
const BUNDLE_ERROR_REASONS = new Set([
  "bundle-too-large",
  "bundle-unavailable",
  "invalid-api-key",
  "invalid-envelope",
  "invalid-json",
  "invalid-provider-count",
  "path-escape",
  "provider-contract-mismatch",
  "provider-id-collision",
  "provider-id-mismatch",
  "unsupported-provider-field",
]);
const PROVIDER_FIELDS = new Set([
  "adapter",
  "baseUrl",
  "disabled",
  "authMode",
  "apiKey",
  "keyOptional",
  "defaultModel",
  "models",
  "liveModels",
  "selectedModels",
  "note",
]);

const DESCRIPTORS: Record<ExternalProviderBundleRef, Descriptor> = {
  "nvidia-glm-5.2": {
    ref: "nvidia-glm-5.2",
    filename: "glm-5.2.disabled.json",
    provider: "nvidia-glm-5.2",
    model: "z-ai/glm-5.2",
    displayName: "NVIDIA | GLM 5.2",
    // GLM-5.2 is model-native 1M; NVIDIA's hosted NIM endpoint caps requests at 202,752.
    contextWindow: 202_752,
    routingEligible: true,
  },
  "nvidia-deepseek-v4-pro": {
    ref: "nvidia-deepseek-v4-pro",
    filename: "deepseek-v4-pro.disabled.json",
    provider: "nvidia-deepseek-v4-pro",
    model: "deepseek-ai/deepseek-v4-pro",
    displayName: "NVIDIA | DeepSeek V4 Pro",
    routingEligible: true,
  },
  "nvidia-kimi-k2.6": {
    ref: "nvidia-kimi-k2.6",
    filename: "kimi-k2.6.disabled.json",
    provider: "nvidia-kimi-k2.6",
    model: "moonshotai/kimi-k2.6",
    displayName: "NVIDIA | Kimi K2.6",
    routingEligible: false,
    unavailableReason: "upstream-model-not-found",
  },
};

let runtimeSecrets: ReadonlyMap<ExternalProviderBundleRef, string> = new Map();
const routingCollisions = new WeakMap<OcxConfig, ReadonlySet<string>>();

export type ExternalSecretResolution =
  | { matched: false }
  | { matched: true; value: string | undefined };

export function resolveExternalProviderSecret(value: string): ExternalSecretResolution {
  if (!value.startsWith(EXTERNAL_SECRET_PREFIX)) return { matched: false };
  const ref = value.slice(EXTERNAL_SECRET_PREFIX.length) as ExternalProviderBundleRef;
  if (!Object.hasOwn(DESCRIPTORS, ref)) return { matched: true, value: undefined };
  return { matched: true, value: runtimeSecrets.get(ref) };
}

export function clearExternalProviderSecrets(): void {
  runtimeSecrets = new Map();
}

export function externalProviderCollisionBlocksRouting(
  config: OcxConfig,
  providerName: string,
): boolean {
  return routingCollisions.get(config)?.has(providerName) === true;
}

/** Friendly picker label for an exact managed-bundle provider/model pair. */
export function externalProviderModelDisplayName(
  providerName: string,
  modelId: string,
): string | undefined {
  const descriptor = Object.values(DESCRIPTORS).find(candidate => (
    candidate.provider === providerName && candidate.model === modelId
  ));
  return descriptor?.displayName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactStringArray(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function parseBundle(bytes: Uint8Array | string, descriptor: Descriptor): string {
  if (Buffer.byteLength(bytes) > MAX_BUNDLE_BYTES) throw new Error("bundle-too-large");
  let parsed: unknown;
  try {
    // Strip a UTF-8 BOM before parsing. `JSON.parse` treats U+FEFF as a syntax error, and on
    // Windows a BOM is the DEFAULT for these files: PowerShell's `>`, `Out-File` and
    // `Set-Content` all emit one, and hand-placing a credential bundle is a PowerShell job.
    // All three shipped bundles on this machine were BOM-prefixed and therefore failed closed
    // as `bundle-error: invalid-json`, so GLM and DeepSeek could never appear in the picker no
    // matter how correct the key was — the same trap CLAUDE.md records for config.json.
    //
    // This only removes an encoding marker. Every envelope, provider-id, field-allowlist and
    // exact-value check below is untouched, so a malformed or tampered bundle still fails
    // closed exactly as before.
    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
    parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    throw new Error("invalid-json");
  }
  if (!isRecord(parsed) || Object.keys(parsed).some(key => key !== "providers")) {
    throw new Error("invalid-envelope");
  }
  const providers = parsed.providers;
  if (!isRecord(providers) || Object.keys(providers).length !== 1) {
    throw new Error("invalid-provider-count");
  }
  const provider = providers[descriptor.provider];
  if (!isRecord(provider)) throw new Error("provider-id-mismatch");
  if (Object.keys(provider).some(key => !PROVIDER_FIELDS.has(key))) {
    // In particular, allowPrivateNetwork is forbidden for this fixed public endpoint.
    throw new Error("unsupported-provider-field");
  }
  if (
    provider.adapter !== "openai-chat"
    || provider.baseUrl !== NVIDIA_BASE_URL
    || provider.authMode !== "key"
    || provider.disabled !== true
    || provider.keyOptional !== false
    || provider.defaultModel !== descriptor.model
    || provider.liveModels !== false
    || !exactStringArray(provider.models, descriptor.model)
    || !exactStringArray(provider.selectedModels, descriptor.model)
  ) {
    throw new Error("provider-contract-mismatch");
  }
  if (
    typeof provider.apiKey !== "string"
    || provider.apiKey.trim().length === 0
    || provider.apiKey !== provider.apiKey.trim()
    || Buffer.byteLength(provider.apiKey) > MAX_API_KEY_BYTES
    || /[\r\n]/.test(provider.apiKey)
  ) {
    throw new Error("invalid-api-key");
  }
  return provider.apiKey;
}

function providerProjection(
  descriptor: Descriptor,
  state: ExternalProviderBundleState,
  reason?: string,
): OcxProviderConfig {
  const ready = state === "ready" || state === "configured-unavailable";
  return {
    adapter: "openai-chat",
    baseUrl: NVIDIA_BASE_URL,
    authMode: "key",
    keyOptional: false,
    ...(ready ? { apiKey: `${EXTERNAL_SECRET_PREFIX}${descriptor.ref}` } : {}),
    defaultModel: descriptor.model,
    models: [descriptor.model],
    selectedModels: [descriptor.model],
    liveModels: false,
    ...(descriptor.contextWindow
      ? { modelContextWindows: { [descriptor.model]: descriptor.contextWindow } }
      : {}),
    freeTier: true,
    note: "Free-tier pricing; an NVIDIA API key is required and remains protected.",
    ...(descriptor.routingEligible && state === "ready" ? {} : { disabled: true }),
    externalProviderRef: descriptor.ref,
    externalProviderState: state,
    ...(reason ? { externalProviderReason: reason } : {}),
  };
}

export type ExternalProviderBundleStatus = {
  ref: ExternalProviderBundleRef;
  provider: string;
  model: string;
  state: ExternalProviderBundleState;
  routingEligible: boolean;
  reason?: string;
};

export function isExternalProviderProjection(
  providerName: string,
  provider: OcxProviderConfig,
): provider is OcxProviderConfig & {
  externalProviderRef: ExternalProviderBundleRef;
  externalProviderState: ExternalProviderBundleState;
} {
  const ref = provider.externalProviderRef as ExternalProviderBundleRef | undefined;
  if (!ref || !Object.hasOwn(DESCRIPTORS, ref)) return false;
  const descriptor = DESCRIPTORS[ref];
  if (descriptor.provider !== providerName) return false;
  if (
    provider.adapter !== "openai-chat"
    || provider.baseUrl !== NVIDIA_BASE_URL
    || provider.authMode !== "key"
    || provider.keyOptional !== false
    || provider.defaultModel !== descriptor.model
    || provider.liveModels !== false
    || provider.freeTier !== true
    || !exactStringArray(provider.models, descriptor.model)
    || !exactStringArray(provider.selectedModels, descriptor.model)
  ) {
    return false;
  }
  if (
    provider.externalProviderState !== "ready"
    && provider.externalProviderState !== "configured-unavailable"
    && provider.externalProviderState !== "bundle-error"
  ) {
    return false;
  }
  const expectedMarker = `${EXTERNAL_SECRET_PREFIX}${descriptor.ref}`;
  if (provider.externalProviderState === "ready") {
    if (!descriptor.routingEligible || provider.disabled === true || provider.apiKey !== expectedMarker) return false;
  } else if (provider.externalProviderState === "configured-unavailable") {
    if (
      descriptor.routingEligible
      || provider.disabled !== true
      || provider.apiKey !== expectedMarker
      || provider.externalProviderReason !== descriptor.unavailableReason
    ) {
      return false;
    }
  } else if (provider.disabled !== true || provider.apiKey !== undefined) {
    return false;
  }
  if (
    provider.externalProviderReason !== undefined
    && provider.externalProviderReason !== descriptor.unavailableReason
    && !BUNDLE_ERROR_REASONS.has(provider.externalProviderReason)
  ) {
    return false;
  }
  return true;
}

export function applyExternalProviderBundles(
  config: OcxConfig,
  options: {
    secretRoot: string;
    readFile: (path: string) => Uint8Array | string;
    /**
     * Diagnostics may project provider state without replacing the process-wide
     * credential store used by the live server.
     */
    activateSecrets?: boolean;
  },
): ExternalProviderBundleStatus[] {
  const requested = config.externalProviderBundles ?? [];
  const statuses: ExternalProviderBundleStatus[] = [];
  const nextSecrets = new Map<ExternalProviderBundleRef, string>();
  const nextRoutingCollisions = new Set<string>();
  const root = resolve(options.secretRoot);

  for (const rawRef of requested) {
    const descriptor = DESCRIPTORS[rawRef as ExternalProviderBundleRef];
    if (!descriptor) continue;
    const existing = config.providers[descriptor.provider];
    if (existing && existing.externalProviderRef !== descriptor.ref) {
      // Preserve the user's provider object for persistence/recovery, but do
      // not let it silently satisfy a configured managed-bundle selector.
      nextRoutingCollisions.add(descriptor.provider);
      statuses.push({
        ref: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        state: "bundle-error",
        routingEligible: false,
        reason: "provider-id-collision",
      });
      continue;
    }

    const target = resolve(root, descriptor.filename);
    if (dirname(target) !== root) {
      config.providers[descriptor.provider] = providerProjection(descriptor, "bundle-error", "path-escape");
      statuses.push({
        ref: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        state: "bundle-error",
        routingEligible: false,
        reason: "path-escape",
      });
      continue;
    }

    try {
      const key = parseBundle(options.readFile(target), descriptor);
      // Kimi is deliberately unroutable after the exact upstream model
      // returned 404. Validate its inert bundle, but retain no usable runtime
      // credential for a provider that cannot be selected.
      if (descriptor.routingEligible) nextSecrets.set(descriptor.ref, key);
      const state: ExternalProviderBundleState = descriptor.routingEligible
        ? "ready"
        : "configured-unavailable";
      const reason = descriptor.unavailableReason;
      config.providers[descriptor.provider] = providerProjection(descriptor, state, reason);
      statuses.push({
        ref: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        state,
        routingEligible: descriptor.routingEligible,
        ...(reason ? { reason } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error && /^[a-z][a-z0-9-]*$/.test(error.message)
        ? error.message
        : "bundle-unavailable";
      config.providers[descriptor.provider] = providerProjection(descriptor, "bundle-error", reason);
      statuses.push({
        ref: descriptor.ref,
        provider: descriptor.provider,
        model: descriptor.model,
        state: "bundle-error",
        routingEligible: false,
        reason,
      });
    }
  }
  if (options.activateSecrets !== false) {
    runtimeSecrets = nextSecrets;
  }
  routingCollisions.set(config, nextRoutingCollisions);
  return statuses;
}
