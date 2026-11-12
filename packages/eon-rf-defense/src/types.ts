// © Infinitum Corporation®. All rights reserved.

/**
 * EON RF-Defense — shared types.
 *
 * This package is DEFENSIVE ONLY. Everything here consumes telemetry that EON's
 * OWN receiver already produces (per-channel C/N0, AGC, a computed fix). It never
 * transmits, never jams, never spoofs, and never intercepts a third party's
 * communications. See ./boundary.ts for the enforced scope.
 */

export type Constellation = "gps" | "galileo" | "glonass" | "beidou";

/** One satellite channel as reported by the host receiver for a single epoch. */
export interface GnssObservable {
  /** Pseudo-random-noise / space-vehicle id, unique within its constellation. */
  prn: number;
  constellation: Constellation;
  /** Carrier-to-noise density, dB-Hz. Typical healthy sky view: ~35–50. */
  cn0_dbhz: number;
  /** Satellite elevation above the horizon, degrees (0–90). */
  elevation_deg: number;
  /** Measured Doppler on the carrier, Hz (sign per receiver convention). */
  doppler_hz: number;
  /** Whether the receiver currently has a tracking lock on this channel. */
  locked: boolean;
}

/** A computed navigation fix for one epoch. */
export interface NavFix {
  lat_deg: number;
  lon_deg: number;
  alt_m: number;
  /** Ground speed from the receiver's own velocity solution, m/s. */
  speed_mps: number;
  /** Horizontal dilution of precision (unitless geometry quality). */
  hdop: number;
}

/** Front-end / RF health counters for one epoch. */
export interface RfFrontEnd {
  /** Automatic-gain-control level, normalised 0..1 (1 = rail / saturated). */
  agc_level: number;
  /** Estimated noise floor at the antenna, dBm. */
  noise_floor_dbm: number;
}

/** Everything the detectors need for a single receiver epoch. */
export interface GnssEpoch {
  /** Monotonic receiver time, milliseconds. */
  t_ms: number;
  observables: GnssObservable[];
  fix: NavFix;
  frontEnd: RfFrontEnd;
  /** Receiver clock bias estimate, nanoseconds. */
  clock_bias_ns: number;
}

export type Severity = "nominal" | "suspect" | "critical";

/** A single named indicator that fired (or did not) within a detector. */
export interface Indicator {
  id: string;
  /** Human-readable, operator-facing explanation. */
  detail: string;
  /** 0..1 contribution toward the detector's confidence. */
  weight: number;
  fired: boolean;
}

/** The result of running one detector over an epoch (given recent history). */
export interface DetectorVerdict {
  kind: "spoofing" | "jamming";
  severity: Severity;
  /** 0..1 aggregate confidence that the threat is present. */
  confidence: number;
  indicators: Indicator[];
}

/** Tunables shared by the detectors; every field has a sane default. */
export interface DefenseConfig {
  /** Baseline mean C/N0 (dB-Hz) for a healthy sky view. */
  nominalCn0_dbhz: number;
  /** C/N0 below this mean (dB-Hz) across locked channels implies broadband jam. */
  jamCn0Floor_dbhz: number;
  /** A uniform C/N0 spread tighter than this (dB-Hz) is spoof-like. */
  spoofCn0Spread_dbhz: number;
  /** AGC at or above this normalised level is treated as rail/saturation. */
  agcSaturation: number;
  /** Noise floor above this (dBm) indicates in-band interference. */
  noiseFloorAlarm_dbm: number;
  /** Fastest physically plausible platform speed, m/s (teleport guard). */
  maxPlatformSpeed_mps: number;
  /** Max tolerated inter-epoch clock-bias jump, nanoseconds. */
  maxClockJump_ns: number;
  /** Max tolerated disagreement between per-constellation fixes, metres. */
  maxConstellationDisagreement_m: number;
}

export const DEFAULT_CONFIG: DefenseConfig = {
  nominalCn0_dbhz: 42,
  jamCn0Floor_dbhz: 28,
  spoofCn0Spread_dbhz: 1.5,
  agcSaturation: 0.92,
  noiseFloorAlarm_dbm: -95,
  maxPlatformSpeed_mps: 340, // ~Mach 1; adjust per platform envelope
  maxClockJump_ns: 500,
  maxConstellationDisagreement_m: 75,
};
