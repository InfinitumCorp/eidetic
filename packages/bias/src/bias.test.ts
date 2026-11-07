// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { UnconfiguredFairlearnBridge, evaluateFairness } from "./index.js";

describe("fairness hook", () => {
  it("computes demographic parity and equalized odds from supplied cohort labels", () => {
    const report = evaluateFairness({
      releaseId: "mvp-0",
      model: "mock-statistical@1",
      cases: [
        { id: "a1", group: "cohort-a", expectedCid: "cid://infinitum/one", predictedCid: "cid://infinitum/one", confidence: 0.9 },
        { id: "a2", group: "cohort-a", expectedCid: null, predictedCid: null, confidence: 0.1 },
        { id: "b1", group: "cohort-b", expectedCid: "cid://infinitum/one", predictedCid: null, confidence: 0.2 },
        { id: "b2", group: "cohort-b", expectedCid: null, predictedCid: "cid://infinitum/two", confidence: 0.4 },
      ],
    });
    expect(report.inferredFromBiometrics).toBe(false);
    expect(report.fairlearn).toBe("not_invoked");
    expect(report.metrics.demographic_parity_difference).toBe(0);
    expect(report.metrics.equalized_odds_difference).toBe(1);
    expect(report.passesLocalThreshold).toBe(false);
    expect(report.byGroup["cohort-a"].truePositiveRate).toBe(1);
    expect(report.byGroup["cohort-b"].falsePositiveRate).toBe(1);
  });

  it("does not shell out to Fairlearn", async () => {
    await expect(new UnconfiguredFairlearnBridge().evaluate({} as never)).rejects.toThrow(/not invoked/);
  });
});
