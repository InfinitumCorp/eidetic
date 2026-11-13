// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { analyzeRun, jammedScenario, nominalScenario, spoofedScenario } from "./index.js";

describe("analyzeRun (after-action report)", () => {
  it("reports a clean run as TRUSTED throughout", () => {
    const r = analyzeRun(nominalScenario({ seed: 21, epochs: 12, stepMs: 1000 }));
    expect(r.epochs).toBe(12);
    expect(r.firstUntrustedAt_ms).toBeNull();
    expect(r.firstDeniedAt_ms).toBeNull();
    expect(r.leadingThreat).toBe("none");
    expect(r.dwell_ms.DENIED).toBe(0);
    expect(r.dwell_ms.DEGRADED).toBe(0);
    expect(r.dwell_ms.TRUSTED).toBeGreaterThan(0);
    expect(r.summary).toMatch(/TRUSTED throughout/);
  });

  it("times the onset of a spoof and attributes the leading threat", () => {
    const r = analyzeRun(
      spoofedScenario({ seed: 21, attackAt: 6, epochs: 14, stepMs: 1000 }),
    );
    expect(r.firstUntrustedAt_ms).not.toBeNull();
    expect(r.firstDeniedAt_ms).not.toBeNull();
    // Onset should be at or after the injection epoch (t = attackAt * stepMs).
    expect(r.firstUntrustedAt_ms!).toBeGreaterThanOrEqual(6 * 1000);
    expect(r.leadingThreat).toBe("spoofing");
    expect(r.peakSpoofConfidence).toBeGreaterThanOrEqual(0.6);
    expect(r.dwell_ms.DENIED).toBeGreaterThan(0);
    expect(r.summary).toMatch(/spoofing/);
  });

  it("attributes a jamming run to jamming", () => {
    const r = analyzeRun(
      jammedScenario({ seed: 22, attackAt: 5, epochs: 12, stepMs: 1000 }),
    );
    expect(r.leadingThreat).toBe("jamming");
    expect(r.peakJamConfidence).toBeGreaterThanOrEqual(0.6);
    expect(r.firstDeniedAt_ms).not.toBeNull();
  });

  it("dwell times sum to the covered span (intervals between epochs)", () => {
    const epochs = spoofedScenario({ seed: 1, attackAt: 4, epochs: 10, stepMs: 1000 });
    const r = analyzeRun(epochs);
    const totalDwell = r.dwell_ms.TRUSTED + r.dwell_ms.DEGRADED + r.dwell_ms.DENIED;
    expect(totalDwell).toBe(r.span_ms);
  });
});
