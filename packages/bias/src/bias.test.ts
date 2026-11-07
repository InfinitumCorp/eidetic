// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { UnconfiguredFairlearnBridge, evaluateFairness, evaluateFixtureFairness } from "./index.js";

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

  it("scores fixture cohorts from metadata and refuses an unknown fixture", () => {
    const report = evaluateFixtureFairness({
      releaseId: "mvp-1",
      model: "mock-statistical@1",
      cases: [
        { id: "1", fixtureId: "avery-quinn", expectedCid: "cid://infinitum/fixture-avery-quinn", predictedCid: "cid://infinitum/fixture-avery-quinn", confidence: 0.97 },
        { id: "2", fixtureId: "jordan-blake", expectedCid: null, predictedCid: null, confidence: 0.18 },
      ],
    });
    expect(report.source).toBe("fixture-metadata");
    expect(report.inferredFromBiometrics).toBe(false);
    expect(report.byGroup["cohort-a"].count).toBe(1);
    expect(report.byGroup["cohort-b"].count).toBe(1);
    expect(() =>
      evaluateFixtureFairness({
        releaseId: "mvp-1",
        model: "mock-statistical@1",
        cases: [{ id: "x", fixtureId: "a-real-person", expectedCid: null, predictedCid: null, confidence: 0 }],
      }),
    ).toThrow(/never inferred/);
  });

  it("does not shell out to Fairlearn", async () => {
    await expect(new UnconfiguredFairlearnBridge().evaluate({} as never)).rejects.toThrow(/not invoked/);
  });
});
