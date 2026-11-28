// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { DeadReckoner, deadReckon, type ImuSample, type NavFix } from "./index.js";
import { haversineMeters } from "./stats.js";

const seedFix: NavFix = {
  lat_deg: 38.9026,
  lon_deg: -77.0408,
  alt_m: 20,
  speed_mps: 10,
  hdop: 0.9,
};

describe("DeadReckoner", () => {
  it("throws if stepped before seeding", () => {
    const dr = new DeadReckoner();
    expect(() => dr.step({ t_ms: 0, accel_mps2: 0, yawRate_dps: 0 })).toThrow();
  });

  it("holds position when stationary", () => {
    const dr = new DeadReckoner();
    dr.seed({ ...seedFix, speed_mps: 0 }, 90, 0);
    const s = dr.step({ t_ms: 5000, accel_mps2: 0, yawRate_dps: 0, speed_mps: 0 });
    const moved = haversineMeters(seedFix.lat_deg, seedFix.lon_deg, s.lat_deg, s.lon_deg);
    expect(moved).toBeLessThan(0.01);
    // Uncertainty still grows with time even when stationary.
    expect(s.posUncertainty_m).toBeGreaterThan(5);
  });

  it("dead-reckons a due-east constant-speed leg to about the right distance", () => {
    // Heading 90° (east), 10 m/s for 10 s -> ~100 m east.
    const samples: ImuSample[] = [];
    for (let t = 1; t <= 10; t++) {
      samples.push({ t_ms: t * 1000, accel_mps2: 0, yawRate_dps: 0, speed_mps: 10 });
    }
    const final = deadReckon(seedFix, 90, 0, samples);
    const dist = haversineMeters(
      seedFix.lat_deg,
      seedFix.lon_deg,
      final.lat_deg,
      final.lon_deg,
    );
    expect(dist).toBeGreaterThan(95);
    expect(dist).toBeLessThan(105);
    // Mostly eastward: longitude increased, latitude ~unchanged.
    expect(final.lon_deg).toBeGreaterThan(seedFix.lon_deg);
    expect(Math.abs(final.lat_deg - seedFix.lat_deg)).toBeLessThan(1e-4);
  });

  it("grows position uncertainty monotonically while coasting", () => {
    const dr = new DeadReckoner();
    dr.seed(seedFix, 0, 0);
    let prev = dr.current()!.posUncertainty_m;
    for (let t = 1; t <= 6; t++) {
      const s = dr.step({ t_ms: t * 1000, accel_mps2: 0, yawRate_dps: 0, speed_mps: 10 });
      expect(s.posUncertainty_m).toBeGreaterThan(prev);
      prev = s.posUncertainty_m;
    }
  });

  it("turns heading under a sustained yaw rate", () => {
    const dr = new DeadReckoner();
    dr.seed(seedFix, 0, 0);
    const s = dr.step({ t_ms: 2000, accel_mps2: 0, yawRate_dps: 45, speed_mps: 5 });
    expect(s.heading_deg).toBeCloseTo(90, 5); // 45 dps * 2 s
  });
});
