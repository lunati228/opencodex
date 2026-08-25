import assert from "node:assert/strict";
import test from "node:test";

import {
  decideCandidate,
  selectSustainedScoringSamples,
  validateFinalTelemetrySummary,
} from "../src/final-live-runner.mjs";

test("final decision applies minimum sample, minimum median, and quality gates exactly", () => {
  assert.equal(
    decideCandidate({
      median8: 3.6,
      median16: 3.4,
      sustainedMedian: 3.3,
      minimumNormalSample: 3.0,
      quality: { baseline_pass: true, exceptional: true },
    }).decision,
    "CONDITIONAL_INTEGRATE",
  );
  assert.equal(
    decideCandidate({
      median8: 3.6,
      median16: 3.4,
      sustainedMedian: 3.3,
      minimumNormalSample: 2.49,
      quality: { baseline_pass: true, exceptional: true },
    }).decision,
    "REMOVE",
  );
  assert.equal(
    decideCandidate({
      median8: 3.6,
      median16: 3.4,
      sustainedMedian: 3.3,
      minimumNormalSample: 3.0,
      quality: { baseline_pass: true, exceptional: false },
    }).decision,
    "FAIL",
  );
});

test("final telemetry requires active PCIe evidence and rejects thermal violations", () => {
  const summary = {
    by_gpu: {
      "GPU-A": {
        active_samples: 3,
        pcie_gen_min_active: 3,
        pcie_width_min_active: 16,
      },
    },
    dmon_summary: {
      thermal_violation_observed: false,
      by_gpu: {
        "GPU-A": { pcie_rx_mb_s_p95: 1, pcie_tx_mb_s_p95: 2 },
      },
    },
  };
  assert.doesNotThrow(() =>
    validateFinalTelemetrySummary(summary, ["GPU-A"]));
  summary.by_gpu["GPU-A"].pcie_gen_min_active = null;
  assert.throws(
    () => validateFinalTelemetrySummary(summary, ["GPU-A"]),
    /FINAL_ACTIVE_PCIE_EVIDENCE_INVALID/,
  );
  summary.by_gpu["GPU-A"].pcie_gen_min_active = 3;
  summary.dmon_summary.thermal_violation_observed = true;
  assert.throws(
    () => validateFinalTelemetrySummary(summary, ["GPU-A"]),
    /FINAL_THERMAL_VIOLATION_OBSERVED/,
  );
  summary.dmon_summary.thermal_violation_observed = false;
  summary.by_gpu["GPU-A"].pcie_gen_min_active = 1;
  summary.by_gpu["GPU-A"].pcie_width_min_active = 1;
  assert.throws(
    () => validateFinalTelemetrySummary(summary, ["GPU-A"]),
    /FINAL_ACTIVE_PCIE_LINK_UNUSABLE/,
  );
});

test("sustained coverage and scoring share exact complete positive timing samples", () => {
  const cases = [
    {
      case_id: "E-01",
      run: {
        rounds: [
          {
            round_index: 0,
            normal_speed_sample: true,
            predicted_n: 64,
            predicted_ms: 32_000,
            decode_tok_s: 2,
          },
          {
            round_index: 1,
            normal_speed_sample: false,
            predicted_n: 64,
            predicted_ms: 16_000,
            decode_tok_s: 4,
          },
          {
            round_index: 2,
            normal_speed_sample: false,
            predicted_n: 8,
            predicted_ms: 1_000,
            decode_tok_s: 8,
          },
        ],
      },
    },
  ];
  assert.deepEqual(selectSustainedScoringSamples(cases), [{
    sample_id: "E-01:0:0",
    case_index: 0,
    case_id: "E-01",
    round_index: 0,
    predicted_n: 64,
    predicted_ms: 32_000,
    decode_tok_s: 2,
  }, {
    sample_id: "E-01:0:1",
    case_index: 0,
    case_id: "E-01",
    round_index: 1,
    predicted_n: 64,
    predicted_ms: 16_000,
    decode_tok_s: 4,
  }]);
  cases[0].run.rounds[0].decode_tok_s = 0;
  assert.throws(
    () => selectSustainedScoringSamples(cases),
    /SUSTAINED_SCORING_SAMPLE_INVALID/,
  );
});
