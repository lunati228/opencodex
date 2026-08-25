import { describe, expect, test } from "bun:test";
import {
  parsePrivateLocalRuntimeProfile,
  resolvePrivateLocalRuntimeProfilePath,
} from "../src/local-runtime/private-profile";

const fixture = {
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
  launchArgs: ["--private-placement-fixture", "enabled"],
  environment: {
    LLAMA_ARG_OFFLINE: "1",
    CUDA_SCALE_LAUNCH_QUEUES: "fixture",
  },
  measuredTokensPerSecond: 1.5,
  measurementNote: "Private fixture measurement.",
};

describe("private managed-local runtime profile", () => {
  test("parses a bounded machine-local profile without publishing it in source", () => {
    expect(parsePrivateLocalRuntimeProfile(
      JSON.stringify(fixture),
      "qwen38-27b-q6kl",
    )).toEqual(fixture);
  });

  test("rejects endpoint, context, and reasoning overrides in private launch args", () => {
    for (const flag of [
      "--model",
      "--mmproj",
      "--host",
      "--port",
      "--alias",
      "--ctx-size",
      "--n-predict",
      "--parallel",
      "--reasoning",
      "--reasoning-effort",
    ]) {
      expect(() => parsePrivateLocalRuntimeProfile(JSON.stringify({
        ...fixture,
        launchArgs: [flag, "unsafe"],
      }), "qwen38-27b-q6kl")).toThrow("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
    }
  });

  test("rejects unknown environment keys and mismatched profile identity", () => {
    expect(() => parsePrivateLocalRuntimeProfile(JSON.stringify({
      ...fixture,
      environment: { PROVIDER_API_KEY: "must-not-propagate" },
    }), "qwen38-27b-q6kl")).toThrow("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
    expect(() => parsePrivateLocalRuntimeProfile(
      JSON.stringify(fixture),
      "some-other-profile",
    )).toThrow("LOCAL_RUNTIME_PRIVATE_PROFILE_INVALID");
  });

  test("uses an explicit path first and otherwise stays under the private config home", () => {
    expect(resolvePrivateLocalRuntimeProfilePath(
      { OPENCODEX_LOCAL_RUNTIME_PROFILE: ".private\\runtime.json" },
      "C:\\Users\\fixture",
      "R:\\repo",
    )).toBe("R:\\repo\\.private\\runtime.json");
    expect(resolvePrivateLocalRuntimeProfilePath(
      { OPENCODEX_HOME: "R:\\ocx-home" },
      "C:\\Users\\fixture",
      "R:\\repo",
    )).toBe("R:\\ocx-home\\local-runtime.private.json");
  });
});
