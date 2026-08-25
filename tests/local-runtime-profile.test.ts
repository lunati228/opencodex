import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_RUNTIME_PROFILE,
  QWEN_PROFILE,
  LOCAL_RUNTIME_MODEL_ID,
  LOCAL_RUNTIME_PROFILE_ID,
  LOCAL_RUNTIME_PROFILES,
  LOCAL_RUNTIME_REASONING_EFFORTS,
  buildLocalRuntimeArgs,
  buildLocalRuntimeEnvironment,
  effectiveLocalRuntimeConnectTimeoutMs,
  isManagedLocalProviderProjection,
  managedLocalProviderProjection,
  validateLocalRuntimeCandidate,
  type LocalRuntimeReasoningEffort,
} from "../src/local-runtime/profile";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { buildCatalogEntries } from "../src/codex/catalog/sync";
import {
  QWEN_CONTEXT_VARIANTS,
  qwenContextVariantModelId,
} from "../src/local-runtime/context-tiers";
import type { PrivateLocalRuntimeProfile } from "../src/local-runtime/private-profile";

const PRIVATE_PROFILE: PrivateLocalRuntimeProfile = {
  schemaVersion: 1,
  profileId: "qwen38-27b-q6kl",
  releaseRoot: "R:\\private-runtime",
  executablePath: "R:\\private-runtime\\llama-server.exe",
  modelPath: "R:\\private-model\\model.gguf",
  projectorPath: "R:\\private-model\\projector.gguf",
  expectedExecutableBytes: 1,
  expectedExecutableSha256: "a".repeat(64),
  expectedModelBytes: 2,
  expectedProjectorBytes: 3,
  expectedBuildNumber: "build-fixture",
  expectedBuildCommit: "commit-fixture",
  serverPredictionLimit: -1,
  launchArgs: ["--private-placement-fixture", "enabled", "--jinja", "--reasoning-preserve"],
  environment: {
    LLAMA_ARG_OFFLINE: "1",
    CUDA_SCALE_LAUNCH_QUEUES: "fixture",
  },
  measuredTokensPerSecond: 1.5,
  measurementNote: "Private fixture measurement.",
};

describe("managed Huihui Qwen3.8 runtime profile", () => {
  test("combines public endpoint controls with a private launch policy", () => {
    const args = buildLocalRuntimeArgs({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 184_320,
    }, PRIVATE_PROFILE);
    const contextIndex = args.indexOf("--ctx-size");

    expect(args[contextIndex + 1]).toBe("184320");
    expect(args[args.indexOf("--model") + 1]).toBe(PRIVATE_PROFILE.modelPath);
    expect(args[args.indexOf("--mmproj") + 1]).toBe(PRIVATE_PROFILE.projectorPath);
    expect(args[args.indexOf("--private-placement-fixture") + 1]).toBe("enabled");
    expect(args[args.indexOf("--parallel") + 1]).toBe("1");
    expect(args).toContain("--jinja");
    expect(args).toContain("--reasoning-preserve");
    expect(args[args.indexOf("--n-predict") + 1]).toBe("-1");
  });

  test("accepts only the two fixed Qwen context checkpoints", () => {
    expect(validateLocalRuntimeCandidate({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131_072,
    })).toEqual({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131_072,
      reasoningEffort: "xhigh",
    });
    expect(validateLocalRuntimeCandidate({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 184_320,
    })).toEqual({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 184_320,
      reasoningEffort: "xhigh",
    });
    expect(() => validateLocalRuntimeCandidate({
      profileId: "arbitrary",
      nCtx: 131_072,
    })).toThrow("LOCAL_RUNTIME_PROFILE_INVALID");
    // Retired picker sizes stay invalid even when they are multiples of the step.
    // 16K/32K/64K/192K/256K were real rows until the trims; a saved
    // config carrying one is migrated by the legacy local-runtime migration, never
    // accepted verbatim here.
    for (const nCtx of [8192, 16_384, 24_576, 32_768, 49_152, 65_536, 98_304, 196_608, 262_144]) {
      expect(() => validateLocalRuntimeCandidate({
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx,
      })).toThrow("LOCAL_RUNTIME_CONTEXT_INVALID");
    }
    expect(() => validateLocalRuntimeCandidate({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 4096,
    })).toThrow("LOCAL_RUNTIME_CONTEXT_INVALID");
    // In range but off-step.
    expect(() => validateLocalRuntimeCandidate({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 12_288,
    })).toThrow("LOCAL_RUNTIME_CONTEXT_INVALID");
    // Above the model card's native 262,144 ceiling.
    expect(() => validateLocalRuntimeCandidate({
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 278_528,
    })).toThrow("LOCAL_RUNTIME_CONTEXT_INVALID");
  });

  test("builds a minimal environment without inheriting provider credentials", () => {
    const env = buildLocalRuntimeEnvironment(PRIVATE_PROFILE, {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      PATH: "C:\\unsafe",
      NVIDIA_API_KEY: "must-not-pass",
      OPENCODEX_API_AUTH_TOKEN: "must-not-pass",
      HOME: "must-not-pass",
    });

    expect(env.NVIDIA_API_KEY).toBeUndefined();
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.LLAMA_ARG_OFFLINE).toBe("1");
    expect(env.GGML_OP_OFFLOAD_MIN_BATCH).toBeUndefined();
    expect(env.PATH).not.toContain("unsafe");
    expect(env.PATH).toContain(PRIVATE_PROFILE.releaseRoot);
  });

  test("projects a keyless provider with two fixed catalog model variants", () => {
    const provider = managedLocalProviderProjection(184_320);
    const modelIds = QWEN_CONTEXT_VARIANTS.map(variant =>
      qwenContextVariantModelId(QWEN_PROFILE.modelId, variant.contextWindow));

    expect(provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "http://127.0.0.1:8080/v1",
      authMode: "local",
      keyOptional: true,
      defaultModel: LOCAL_RUNTIME_MODEL_ID,
      contextWindow: 184_320,
      modelSuffixBracketStrip: true,
      localRuntimeProfileId: LOCAL_RUNTIME_PROFILE_ID,
    });
    expect(provider.models).toEqual(modelIds);
    expect(provider.selectedModels).toEqual(modelIds);
    expect(provider.modelContextWindows).toEqual(Object.fromEntries(
      QWEN_CONTEXT_VARIANTS.map(variant => [
        qwenContextVariantModelId(QWEN_PROFILE.modelId, variant.contextWindow),
        variant.contextWindow,
      ]),
    ));
    expect(provider.modelInputModalities).toEqual(Object.fromEntries(
      modelIds.map(modelId => [modelId, ["text", "image"]]),
    ));
    expect(provider.noVisionModels).toBeUndefined();
    expect(provider.apiKey).toBeUndefined();
    expect(provider.defaultMaxOutputTokens).toBeUndefined();
    expect(provider.modelMaxOutputTokens).toBeUndefined();
  });
});

describe("local runtime profile registry", () => {
  test("exposes only Qwen and rejects the retired Ornith profile", () => {
    expect(LOCAL_RUNTIME_PROFILES.map(profile => profile.id))
      .toEqual(["qwen38-27b-q6kl"]);
    expect(DEFAULT_LOCAL_RUNTIME_PROFILE.id).toBe("qwen38-27b-q6kl");
    expect(LOCAL_RUNTIME_PROFILE_ID).toBe("qwen38-27b-q6kl");
    expect(() => validateLocalRuntimeCandidate({
      profileId: "ornith-balanced",
      nCtx: 8192,
    })).toThrow("LOCAL_RUNTIME_PROFILE_INVALID");
  });

  test("keeps machine identity out of the public profile", () => {
    for (const field of [
      "modelPath",
      "projectorPath",
      "expectedModelBytes",
      "expectedProjectorBytes",
      "measuredTokensPerSecond",
      "measurementNote",
      "serverPredictionLimit",
    ]) {
      expect(field in QWEN_PROFILE).toBe(false);
    }
  });

  test("keeps only the two fixed Qwen context rows", () => {
    expect(QWEN_PROFILE.context).toEqual({ min: 16_384, max: 184_320, step: 1_024 });
    expect(QWEN_PROFILE.defaultContext).toBe(184_320);
    expect(QWEN_PROFILE.contextCheckpoints).toEqual(
      QWEN_CONTEXT_VARIANTS.map(variant => variant.contextWindow),
    );
    expect(() => validateLocalRuntimeCandidate({
      profileId: "qwen38-27b-q6kl",
      nCtx: 4096,
    })).toThrow("LOCAL_RUNTIME_CONTEXT_INVALID");
  });

  test("reasoning effort is passed to the official Qwen chat template", () => {
    const budgetOf = (effort: LocalRuntimeReasoningEffort): string | undefined => {
      const args = buildLocalRuntimeArgs({
        profileId: "qwen38-27b-q6kl",
        nCtx: 184_320,
        reasoningEffort: effort,
      }, PRIVATE_PROFILE);
      const index = args.indexOf("--reasoning-effort");
      return index === -1 ? undefined : args[index + 1];
    };

    expect(budgetOf("low")).toBe("low");
    expect(budgetOf("medium")).toBe("medium");
    expect(budgetOf("xhigh")).toBe("xhigh");
    expect(PRIVATE_PROFILE.serverPredictionLimit).toBe(-1);

    for (const legacy of ["high", "max"]) {
      const candidate = validateLocalRuntimeCandidate({
        profileId: "qwen38-27b-q6kl",
        nCtx: 184_320,
        reasoningEffort: legacy,
      });
      expect(candidate.reasoningEffort).toBe("xhigh");
    }

    const legacyHigh = buildLocalRuntimeArgs({
      profileId: "qwen38-27b-q6kl",
      nCtx: 184_320,
      reasoningEffort: "high",
    }, PRIVATE_PROFILE);
    expect(legacyHigh[legacyHigh.indexOf("--n-predict") + 1]).toBe("-1");
    expect(legacyHigh[legacyHigh.indexOf("--reasoning-effort") + 1]).toBe("xhigh");

    // "off" must disable thinking outright rather than pass a zero budget.
    const off = buildLocalRuntimeArgs({
      profileId: "qwen38-27b-q6kl",
      nCtx: 184_320,
      reasoningEffort: "off",
    }, PRIVATE_PROFILE);
    expect(off[off.indexOf("--reasoning") + 1]).toBe("off");
    expect(off).not.toContain("--reasoning-effort");
    expect(off).not.toContain("--reasoning-budget");
  });

  test("an absent reasoning effort resolves to the profile's own default", () => {
    expect(validateLocalRuntimeCandidate({
      profileId: "qwen38-27b-q6kl",
      nCtx: 184_320,
    }).reasoningEffort).toBe("xhigh");
    expect(() => validateLocalRuntimeCandidate({
      profileId: "qwen38-27b-q6kl",
      nCtx: 184_320,
      reasoningEffort: "maximum",
    })).toThrow("LOCAL_RUNTIME_REASONING_INVALID");
  });

});

describe("managed Qwen reasoning contract", () => {
  const provider = managedLocalProviderProjection(QWEN_PROFILE.defaultContext);

  test("publishes only Qwen's native picker levels", () => {
    expect(LOCAL_RUNTIME_REASONING_EFFORTS).toEqual(["off", "low", "medium", "xhigh"]);
    expect(QWEN_PROFILE.reasoningEfforts).toEqual(LOCAL_RUNTIME_REASONING_EFFORTS);
    for (const variant of QWEN_CONTEXT_VARIANTS) {
      const modelId = qwenContextVariantModelId(QWEN_PROFILE.modelId, variant.contextWindow);
      expect(provider.modelReasoningEfforts?.[modelId]).toEqual(["low", "medium", "xhigh"]);
      expect(provider.modelDefaultReasoningEfforts?.[modelId]).toBe("xhigh");
    }
  });

  test("maps only stale high/max and harness ultra input to Qwen xhigh on the wire", () => {
    for (const requested of ["high", "max", "ultra"]) {
      expect(mapReasoningEffort(provider, QWEN_PROFILE.modelId, requested)).toBe("xhigh");
    }
    for (const requested of ["low", "medium", "xhigh"]) {
      expect(mapReasoningEffort(provider, QWEN_PROFILE.modelId, requested)).toBe(requested);
    }
  });

  test("does not synthesize high, max, or ultra into managed Qwen catalog rows", () => {
    const entries = buildCatalogEntries(null, [], [{
      provider: QWEN_PROFILE.providerId,
      id: QWEN_PROFILE.modelId,
      reasoningEfforts: ["low", "medium", "xhigh"],
      defaultReasoningEffort: "xhigh",
    }]);
    const qwen = entries.find(entry => entry.slug === `${QWEN_PROFILE.providerId}/${QWEN_PROFILE.modelId}`);
    expect((qwen?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium", "xhigh"]);
    expect(qwen?.default_reasoning_level).toBe("xhigh");
  });
});

describe("projection recognition survives adding fields", () => {
  // Regression for the P46 dead end: a stored projection written by an older build lacks
  // fields added later. If that is classified as user-owned, controlled() flips false and every
  // control answers 409 "collision" - including the one that would repair it.
  test("a projection missing later reasoning fields is still recognised as ours", () => {
    const fresh = managedLocalProviderProjection(131_072, LOCAL_RUNTIME_PROFILE_ID);
    const legacy = { ...fresh };
    for (const field of [
      "modelReasoningEfforts",
      "modelDefaultReasoningEfforts",
      "modelReasoningEffortMap",
    ]) {
      delete (legacy as Record<string, unknown>)[field];
    }
    expect(isManagedLocalProviderProjection(QWEN_PROFILE.providerId, legacy)).toBe(true);
  });

  test("the current shape is recognised", () => {
    const fresh = managedLocalProviderProjection(131_072, LOCAL_RUNTIME_PROFILE_ID);
    expect(isManagedLocalProviderProjection(QWEN_PROFILE.providerId, fresh)).toBe(true);
  });

  test("the retired 192K/xhigh shape is recognised for migration", () => {
    const retired = managedLocalProviderProjection(184_320, LOCAL_RUNTIME_PROFILE_ID);
    retired.contextWindow = 196_608;
    retired.modelContextWindows = {
      [`${QWEN_PROFILE.modelId}[128K]`]: 131_072,
      [QWEN_PROFILE.modelId]: 196_608,
    };
    expect(isManagedLocalProviderProjection(QWEN_PROFILE.providerId, retired)).toBe(true);
  });

  test("the retired 256K/medium/output-capped shape is recognised for migration", () => {
    const baseModel = QWEN_PROFILE.modelId;
    const modelIds = [`${baseModel}[128K]`, baseModel];
    const retired = {
      adapter: "openai-chat" as const,
      baseUrl: "http://127.0.0.1:8080/v1",
      allowPrivateNetwork: true,
      authMode: "local" as const,
      keyOptional: true,
      freeTier: true,
      defaultModel: baseModel,
      models: modelIds,
      selectedModels: modelIds,
      liveModels: false,
      contextWindow: 262_144,
      modelContextWindows: { [modelIds[0]!]: 131_072, [baseModel]: 262_144 },
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
      localRuntimeProfileId: LOCAL_RUNTIME_PROFILE_ID,
    };

    expect(isManagedLocalProviderProjection(QWEN_PROFILE.providerId, retired)).toBe(true);
  });

  test("a genuinely user-owned provider is not mistaken for ours", () => {
    const fresh = managedLocalProviderProjection(131_072, LOCAL_RUNTIME_PROFILE_ID);
    expect(
      isManagedLocalProviderProjection(QWEN_PROFILE.providerId, { ...fresh, apiKey: "sk-user" }),
    ).toBe(false);
  });
});

describe("managed local provider connect timeout", () => {
  const managed = managedLocalProviderProjection(184_320, LOCAL_RUNTIME_PROFILE_ID);

  test("allows near-native-context prompt ingestion without changing cloud defaults", () => {
    expect(
      effectiveLocalRuntimeConnectTimeoutMs(undefined, QWEN_PROFILE.providerId, managed),
    ).toBe(900_000);
    expect(
      effectiveLocalRuntimeConnectTimeoutMs(undefined, "openai", managed),
    ).toBe(200_000);
  });

  test("preserves an explicit operator override", () => {
    expect(
      effectiveLocalRuntimeConnectTimeoutMs(42_000, QWEN_PROFILE.providerId, managed),
    ).toBe(42_000);
  });
});
