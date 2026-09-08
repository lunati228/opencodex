import { describe, expect, test } from "bun:test";
import { hasReadyLocalRuntimeVision } from "../src/local-runtime/production";

describe("local runtime vision metadata", () => {
  test("accepts only an awake runtime with an affirmative vision modality", () => {
    expect(hasReadyLocalRuntimeVision({
      is_sleeping: false,
      modalities: { vision: true, audio: false },
    })).toBe(true);
  });

  test("missing, false, malformed, sleeping, or label-only metadata disables images", () => {
    const fixtures: Record<string, unknown>[] = [
      {},
      { is_sleeping: false },
      { is_sleeping: false, modalities: null },
      { is_sleeping: false, modalities: [] },
      { is_sleeping: false, modalities: [{ vision: true }] },
      { is_sleeping: false, modalities: Object.assign([], { vision: true }) },
      { is_sleeping: false, modalities: "vision" },
      { is_sleeping: false, modalities: true },
      { is_sleeping: false, modalities: { audio: true } },
      { is_sleeping: false, modalities: { vision: false } },
      { is_sleeping: false, modalities: { vision: "true" } },
      { is_sleeping: false, modalities: { vision: 1 } },
      { is_sleeping: true, modalities: { vision: true } },
      { is_sleeping: "false", modalities: { vision: true } },
      { is_sleeping: 0, modalities: { vision: true } },
      { modalities: { vision: true } },
      { is_sleeping: false, model_alias: "vision + MTP", capabilities: ["multimodal"] },
    ];
    for (const props of fixtures) expect(hasReadyLocalRuntimeVision(props)).toBe(false);
  });
});
