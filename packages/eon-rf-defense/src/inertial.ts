// © Infinitum Corporation®. All rights reserved.

import type { NavFix } from "./types.js";

/**
 * Inertial dead-reckoning fallback.
 *
 * When the PNT monitor declares GNSS DENIED (see pnt.ts), the platform should
 * stop trusting the satellite fix and propagate position from an independent
 * source. This is a lightweight 2-D strapdown-style propagator: seed it with
 * the last trusted fix + heading, then feed IMU-like samples (forward
 * acceleration + yaw rate, or a direct speed) to roll position forward, with a
 * position-uncertainty estimate that grows while GNSS is unavailable.
 *
 * It is deliberately simple and dependency-free — enough to hold a track for
 * the seconds-to-minutes a jamming/spoofing event typically lasts, and to tell
 * the operator how much that held position can still be trusted.
 */

const M_PER_DEG_LAT = 111_320;

export interface ImuSample {
  t_ms: number;
  /** Forward (body-x) acceleration, m/s². */
  accel_mps2: number;
  /** Yaw rate (turn rate), degrees/second; +ve turns heading clockwise. */
  yawRate_dps: number;
  /** Optional directly-measured ground speed (e.g. wheel/air data), m/s. */
  speed_mps?: number;
}

export interface DeadReckonState {
  t_ms: number;
  lat_deg: number;
  lon_deg: number;
  heading_deg: number;
  speed_mps: number;
  /** 1-sigma horizontal position uncertainty, metres (grows while coasting). */
  posUncertainty_m: number;
  /** Seconds since the last trusted GNSS seed. */
  elapsed_s: number;
}

export interface DeadReckonConfig {
  /** Uncertainty added per metre travelled (scale-factor drift), metres/metre. */
  driftPerMeter: number;
  /** Uncertainty added per second regardless of motion (bias drift), metres/s. */
  driftPerSecond: number;
  /** Starting 1-sigma uncertainty at seed time, metres. */
  seedUncertainty_m: number;
}

export const DEFAULT_DR_CONFIG: DeadReckonConfig = {
  driftPerMeter: 0.02, // 2% of distance travelled
  driftPerSecond: 0.5, // 0.5 m per second of coasting
  seedUncertainty_m: 5,
};

function norm360(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

export class DeadReckoner {
  private readonly config: DeadReckonConfig;
  private state: DeadReckonState | null = null;
  private seedT_ms = 0;

  constructor(config: DeadReckonConfig = DEFAULT_DR_CONFIG) {
    this.config = config;
  }

  /** Seed (or re-seed) from the last trusted fix and a known heading. */
  seed(fix: NavFix, heading_deg: number, t_ms: number): DeadReckonState {
    this.seedT_ms = t_ms;
    this.state = {
      t_ms,
      lat_deg: fix.lat_deg,
      lon_deg: fix.lon_deg,
      heading_deg: norm360(heading_deg),
      speed_mps: Math.max(0, fix.speed_mps),
      posUncertainty_m: this.config.seedUncertainty_m,
      elapsed_s: 0,
    };
    return { ...this.state };
  }

  /** Propagate one IMU sample forward. Must be seeded first. */
  step(sample: ImuSample): DeadReckonState {
    const s = this.state;
    if (!s) throw new Error("DeadReckoner.step() called before seed()");
    const dt = Math.max(0, (sample.t_ms - s.t_ms) / 1000);

    const heading = norm360(s.heading_deg + sample.yawRate_dps * dt);
    const speed =
      sample.speed_mps !== undefined
        ? Math.max(0, sample.speed_mps)
        : Math.max(0, s.speed_mps + sample.accel_mps2 * dt);

    // Trapezoidal distance over the step.
    const distance = ((s.speed_mps + speed) / 2) * dt;
    const hdgRad = (heading * Math.PI) / 180;
    const dNorth = distance * Math.cos(hdgRad);
    const dEast = distance * Math.sin(hdgRad);

    const lat = s.lat_deg + dNorth / M_PER_DEG_LAT;
    const cosLat = Math.cos((s.lat_deg * Math.PI) / 180);
    const lon =
      s.lon_deg + dEast / (M_PER_DEG_LAT * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));

    const posUncertainty_m =
      s.posUncertainty_m +
      Math.abs(distance) * this.config.driftPerMeter +
      dt * this.config.driftPerSecond;

    this.state = {
      t_ms: sample.t_ms,
      lat_deg: lat,
      lon_deg: lon,
      heading_deg: heading,
      speed_mps: speed,
      posUncertainty_m,
      elapsed_s: (sample.t_ms - this.seedT_ms) / 1000,
    };
    return { ...this.state };
  }

  /** Current propagated state, or null if never seeded. */
  current(): DeadReckonState | null {
    return this.state ? { ...this.state } : null;
  }
}

/**
 * Convenience: seed once and propagate a whole IMU batch, returning the final
 * dead-reckoned state. Useful for replaying a logged denial window.
 */
export function deadReckon(
  seedFix: NavFix,
  heading_deg: number,
  seedT_ms: number,
  samples: readonly ImuSample[],
  config: DeadReckonConfig = DEFAULT_DR_CONFIG,
): DeadReckonState {
  const dr = new DeadReckoner(config);
  dr.seed(seedFix, heading_deg, seedT_ms);
  let last = dr.current()!;
  for (const s of samples) last = dr.step(s);
  return last;
}
