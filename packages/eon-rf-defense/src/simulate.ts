// © Infinitum Corporation®. All rights reserved.

import type {
  Constellation,
  GnssEpoch,
  GnssObservable,
  NavFix,
} from "./types.js";

/**
 * Synthetic telemetry generator for TESTING the detectors.
 *
 * This produces NUMBERS ONLY — arrays of plausible receiver telemetry for
 * nominal, spoofed, and jammed conditions. It has no radio, generates no RF,
 * and emits nothing to any antenna. Its sole purpose is to exercise and
 * regression-test the defensive detectors without a live sky or a test range.
 *
 * Determinism: a seeded PRNG so tests are stable.
 */

/** Tiny deterministic PRNG (mulberry32) — reproducible, not cryptographic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSTELLATIONS: Constellation[] = ["gps", "galileo", "glonass"];

export interface ScenarioOptions {
  seed?: number;
  epochs?: number;
  /** Channels per epoch. */
  satellites?: number;
  /** Epoch spacing, ms. */
  stepMs?: number;
  /** Starting fix. */
  origin?: { lat_deg: number; lon_deg: number; alt_m: number };
}

const DEFAULTS: Required<ScenarioOptions> = {
  seed: 1,
  epochs: 20,
  satellites: 9,
  stepMs: 1000,
  origin: { lat_deg: 38.9026, lon_deg: -77.0408, alt_m: 20 },
};

function healthyObservables(
  rng: () => number,
  count: number,
): GnssObservable[] {
  const out: GnssObservable[] = [];
  for (let i = 0; i < count; i++) {
    const elevation = 10 + rng() * 75;
    // Real C/N0 tracks elevation and varies channel to channel.
    const cn0 = 33 + (elevation / 90) * 14 + (rng() - 0.5) * 3;
    out.push({
      prn: i + 1,
      constellation: CONSTELLATIONS[i % CONSTELLATIONS.length]!,
      cn0_dbhz: Number(cn0.toFixed(1)),
      elevation_deg: Number(elevation.toFixed(1)),
      doppler_hz: Number(((rng() - 0.5) * 4000).toFixed(1)),
      locked: true,
    });
  }
  return out;
}

function baseFix(origin: ScenarioOptions["origin"]): NavFix {
  const o = origin ?? DEFAULTS.origin;
  return { lat_deg: o.lat_deg, lon_deg: o.lon_deg, alt_m: o.alt_m, speed_mps: 0, hdop: 0.9 };
}

/** A calm, trustworthy run: steady fix, varied C/N0, quiet front-end. */
export function nominalScenario(options: ScenarioOptions = {}): GnssEpoch[] {
  const opt = { ...DEFAULTS, ...options };
  const rng = mulberry32(opt.seed);
  const epochs: GnssEpoch[] = [];
  let lat = opt.origin.lat_deg;
  const lon = opt.origin.lon_deg;
  for (let e = 0; e < opt.epochs; e++) {
    lat += 0.00001 * (rng() - 0.5); // sub-metre jitter
    epochs.push({
      t_ms: e * opt.stepMs,
      observables: healthyObservables(rng, opt.satellites),
      fix: { ...baseFix(opt.origin), lat_deg: lat, lon_deg: lon, speed_mps: 0.4 * rng() },
      frontEnd: { agc_level: 0.45 + rng() * 0.1, noise_floor_dbm: -108 + rng() * 2 },
      clock_bias_ns: 12 + (rng() - 0.5) * 20,
    });
  }
  return epochs;
}

/**
 * Nominal, then from `attackAt` a spoof capture: uniform/elevated C/N0,
 * collapsed Doppler, a position teleport, and a clock step.
 */
export function spoofedScenario(
  options: ScenarioOptions & { attackAt?: number } = {},
): GnssEpoch[] {
  const opt = { ...DEFAULTS, ...options };
  const attackAt = options.attackAt ?? Math.floor(opt.epochs / 2);
  const epochs = nominalScenario(opt);
  const rng = mulberry32(opt.seed + 101);
  for (let e = attackAt; e < epochs.length; e++) {
    const ep = epochs[e]!;
    ep.observables = ep.observables.map((o) => ({
      ...o,
      cn0_dbhz: Number((47.5 + (rng() - 0.5) * 0.6).toFixed(1)), // uniform + hot
      doppler_hz: Number((500 + (rng() - 0.5) * 10).toFixed(1)), // collapsed
      locked: true,
    }));
    // Teleport ~2 km east of origin and hold there.
    ep.fix = {
      ...ep.fix,
      lat_deg: opt.origin.lat_deg,
      lon_deg: opt.origin.lon_deg + 0.023,
      speed_mps: 0.3,
    };
    ep.clock_bias_ns = 3200 + (rng() - 0.5) * 40; // re-lock to false time
  }
  return epochs;
}

/**
 * Nominal, then from `attackAt` broadband jamming: AGC rails, noise floor
 * rises, C/N0 collapses, most channels drop lock.
 */
export function jammedScenario(
  options: ScenarioOptions & { attackAt?: number } = {},
): GnssEpoch[] {
  const opt = { ...DEFAULTS, ...options };
  const attackAt = options.attackAt ?? Math.floor(opt.epochs / 2);
  const epochs = nominalScenario(opt);
  const rng = mulberry32(opt.seed + 202);
  for (let e = attackAt; e < epochs.length; e++) {
    const ep = epochs[e]!;
    ep.observables = ep.observables.map((o, i) => ({
      ...o,
      cn0_dbhz: Number((20 + rng() * 5).toFixed(1)),
      locked: i < 1, // all but one channel lose lock
    }));
    ep.frontEnd = { agc_level: 0.97, noise_floor_dbm: -88 + rng() * 2 };
  }
  return epochs;
}
