import { describe, expect, test } from "bun:test";
import {
  hasMinimumAvailableHostMemory,
  selectManagedLocalRuntimeReadyOperation,
} from "../src/local-runtime/production";
import { QWEN_DEFAULT_CONTEXT } from "../src/local-runtime/context-tiers";
import { LOCAL_RUNTIME_PROFILE_ID } from "../src/local-runtime/profile";
import type { LocalRuntimeStatus } from "../src/local-runtime/supervisor";
import type { OcxConfig } from "../src/types";

function config(nCtx = 131_072): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    localRuntime: {
      enabled: true,
      autoStart: false,
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx,
      reasoningEffort: "xhigh",
      verifiedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function status(overrides: Partial<LocalRuntimeStatus>): LocalRuntimeStatus {
  return {
    state: "stopped",
    revision: 7,
    requested: null,
    effective: null,
    lastKnownGood: {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131_072,
      reasoningEffort: "xhigh",
    },
    failure: null,
    pid: null,
    operationPending: false,
    ...overrides,
  };
}

describe("managed local runtime on-demand operation selection", () => {
  test("compares available bytes against an optional MiB safety reserve", () => {
    const oneMiB = 1024 * 1024;

    expect(hasMinimumAvailableHostMemory(1, undefined)).toBe(true);
    expect(hasMinimumAvailableHostMemory(6_144 * oneMiB, 6_144)).toBe(true);
    expect(hasMinimumAvailableHostMemory((6_144 * oneMiB) - 1, 6_144)).toBe(false);
  });

  test("a stopped supervisor cold-starts the desired context instead of applying and rolling back", () => {
    const operation = selectManagedLocalRuntimeReadyOperation(
      config(),
      status({}),
      QWEN_DEFAULT_CONTEXT,
    );

    // `apply` carries last-known-good rollback semantics. With no owned/live
    // runtime that would load the desired model once, then load the old context
    // a second time after a readiness failure. A cold start gets exactly one
    // launch attempt and still starts at the context named by the picker.
    expect(operation).toEqual({
      kind: "start",
      candidate: {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: QWEN_DEFAULT_CONTEXT,
        reasoningEffort: "xhigh",
      },
    });
  });

  test("an owned running runtime at a different context uses apply", () => {
    const current = {
      profileId: LOCAL_RUNTIME_PROFILE_ID,
      nCtx: 131_072,
      reasoningEffort: "xhigh" as const,
    };
    const operation = selectManagedLocalRuntimeReadyOperation(
      config(),
      status({
        state: "running",
        requested: current,
        effective: {
          ...current,
          model: "huihui-qwen3.8-27b-abliterated-q6-k-l",
          verifiedAt: "2026-07-27T00:00:00.000Z",
        },
        pid: 4000,
      }),
      QWEN_DEFAULT_CONTEXT,
    );

    expect(operation).toEqual({
      kind: "apply",
      candidate: {
        profileId: LOCAL_RUNTIME_PROFILE_ID,
        nCtx: QWEN_DEFAULT_CONTEXT,
        reasoningEffort: "xhigh",
      },
      expectedRevision: 7,
    });
  });
});
