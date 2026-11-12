// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { EideticError } from "@eidetic/contracts";
import {
  PntIntegrityMonitor,
  assertDefensiveOnly,
  constellationDisagreement,
  detectJamming,
  detectSpoofing,
  jammedScenario,
  nominalScenario,
  refuseOffensiveRf,
  spoofedScenario,
} from "./index.js";

describe("EON RF-Defense boundary (fail closed, like @eidetic/geo and @eidetic/mil)", () => {
  it("refuses offensive / interception requests", () => {
    for (const req of [
      "jam the uplink",
      "spoof GPS for the target",
      "transmit a false beacon",
      "intercept their comms",
      "run sigint collection",
      "deauth the AP",
    ]) {
      expect(() => assertDefensiveOnly(req)).toThrow(EideticError);
      expect(() => assertDefensiveOnly(req)).toThrow(/does not transmit|Refused/i);
    }
  });

  it("lets through legitimate defensive actions", () => {
    expect(assertDefensiveOnly("  assess pnt integrity  ")).toBe("assess pnt integrity");
    expect(assertDefensiveOnly("recommend inertial fallback")).toBe(
      "recommend inertial fallback",
    );
  });

  it("refuseOffensiveRf always throws a non-retryable 403", () => {
    try {
      refuseOffensiveRf("mount a jammer");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(EideticError);
      const e = err as EideticError;
      expect(e.code).toBe("FORBIDDEN");
      expect(e.httpStatus).toBe(403);
      expect(e.matchRan).toBe(false);
    }
  });
});

describe("detectSpoofing", () => {
  it("stays nominal on a clean sky view", () => {
    const epochs = nominalScenario({ seed: 7 });
    const v = detectSpoofing(epochs[1]!, epochs[0]!);
    expect(v.severity).toBe("nominal");
    expect(v.confidence).toBeLessThan(0.3);
  });

  it("flags a spoof capture as critical", () => {
    const epochs = spoofedScenario({ seed: 7, attackAt: 10, epochs: 20 });
    // Compare the first spoofed epoch against the last clean one.
    const v = detectSpoofing(epochs[10]!, epochs[9]!);
    expect(v.confidence).toBeGreaterThanOrEqual(0.6);
    expect(v.severity).toBe("critical");
    const fired = v.indicators.filter((i) => i.fired).map((i) => i.id);
    expect(fired).toEqual(
      expect.arrayContaining(["uniform_cn0", "position_jump", "doppler_collapse"]),
    );
  });
});

describe("constellationDisagreement", () => {
  it("passes co-located fixes and fails a targeted spoof split", () => {
    const base = { lat_deg: 38.9026, lon_deg: -77.0408 };
    expect(constellationDisagreement(base, base).breached).toBe(false);
    const split = { lat_deg: 38.9026, lon_deg: -77.03 }; // ~940 m east
    expect(constellationDisagreement(base, split).breached).toBe(true);
  });
});

describe("detectJamming", () => {
  it("stays nominal with a quiet front-end", () => {
    const epochs = nominalScenario({ seed: 3 });
    const v = detectJamming(epochs[1]!, epochs[0]!);
    expect(v.severity).toBe("nominal");
  });

  it("flags broadband jamming as critical", () => {
    const epochs = jammedScenario({ seed: 3, attackAt: 10, epochs: 20 });
    const v = detectJamming(epochs[10]!, epochs[9]!);
    expect(v.confidence).toBeGreaterThanOrEqual(0.6);
    expect(v.severity).toBe("critical");
    const fired = v.indicators.filter((i) => i.fired).map((i) => i.id);
    expect(fired).toEqual(
      expect.arrayContaining(["agc_saturation", "noise_floor_rise", "cn0_collapse"]),
    );
  });
});

describe("PntIntegrityMonitor", () => {
  it("holds TRUSTED across a clean run and recommends GNSS", () => {
    const mon = new PntIntegrityMonitor();
    let last = mon.currentState;
    for (const ep of nominalScenario({ seed: 11, epochs: 15 })) {
      const a = mon.assess(ep);
      last = a.state;
      expect(a.recommendation).toBe("USE_GNSS");
    }
    expect(last).toBe("TRUSTED");
  });

  it("escalates to DENIED under spoofing and recommends inertial fallback", () => {
    const mon = new PntIntegrityMonitor();
    const epochs = spoofedScenario({ seed: 11, attackAt: 8, epochs: 16 });
    const assessments = epochs.map((ep) => mon.assess(ep));
    const underAttack = assessments[9]!;
    expect(underAttack.state).toBe("DENIED");
    expect(underAttack.recommendation).toBe("FALLBACK_INERTIAL_DEAD_RECKONING");
    expect(underAttack.summary).toMatch(/spoofing/);
  });

  it("escalates immediately but only de-escalates after a clean streak (hysteresis)", () => {
    const mon = new PntIntegrityMonitor({ clearingEpochs: 3 });
    // 4 clean, 1 jam, then clean again.
    const clean = nominalScenario({ seed: 5, epochs: 4 });
    const jam = jammedScenario({ seed: 5, attackAt: 0, epochs: 1 });
    const recover = nominalScenario({ seed: 6, epochs: 4 });

    for (const ep of clean) mon.assess(ep);
    expect(mon.currentState).toBe("TRUSTED");

    mon.assess({ ...jam[0]!, t_ms: 10_000 });
    expect(mon.currentState).toBe("DENIED"); // immediate escalation

    const states = recover.map((ep, i) =>
      mon.assess({ ...ep, t_ms: 11_000 + i * 1000 }).state,
    );
    // Must not snap straight back to TRUSTED on the first clean epoch.
    expect(states[0]).not.toBe("TRUSTED");
    // After enough clean epochs it relaxes (DENIED -> DEGRADED -> TRUSTED).
    expect(mon.currentState).not.toBe("DENIED");
  });
});
