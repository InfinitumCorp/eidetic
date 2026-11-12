// © Infinitum Corporation®. All rights reserved.

import {
  DEFAULT_CONFIG,
  type DefenseConfig,
  type DetectorVerdict,
  type GnssEpoch,
  type Indicator,
  type Severity,
} from "./types.js";
import { clamp01, haversineMeters, mean, stddev } from "./stats.js";

/**
 * GNSS spoofing detection.
 *
 * A spoofer replaces authentic satellite signals with a stronger, fabricated
 * set so the victim computes an attacker-chosen position/time. Characteristic
 * fingerprints — none decisive alone, so we score a consensus:
 *
 *   1. Uniform, elevated C/N0 across all channels (one transmitter, one range).
 *   2. A position jump faster than the platform can physically move (capture).
 *   3. A receiver-clock discontinuity as the victim re-locks to false time.
 *   4. Near-identical Doppler across channels (signals from a single source).
 *   5. Per-constellation fixes that disagree (spoofer targeted one system).
 *
 * `previous` is the last epoch (if any) for rate-based indicators.
 */
export function detectSpoofing(
  epoch: GnssEpoch,
  previous: GnssEpoch | null,
  config: DefenseConfig = DEFAULT_CONFIG,
): DetectorVerdict {
  const locked = epoch.observables.filter((o) => o.locked);
  const cn0 = locked.map((o) => o.cn0_dbhz);
  const indicators: Indicator[] = [];

  // 1. Uniform + elevated C/N0.
  const cn0Spread = stddev(cn0);
  const cn0Mean = mean(cn0);
  const uniformStrong =
    locked.length >= 4 &&
    cn0Spread < config.spoofCn0Spread_dbhz &&
    cn0Mean >= config.nominalCn0_dbhz;
  indicators.push({
    id: "uniform_cn0",
    detail: `C/N0 spread ${cn0Spread.toFixed(2)} dB-Hz at mean ${cn0Mean.toFixed(
      1,
    )} dB-Hz (real sky view varies by elevation).`,
    weight: 0.3,
    fired: uniformStrong,
  });

  // 2. Physically impossible position jump.
  let teleport = false;
  if (previous) {
    const dt_s = Math.max(1e-3, (epoch.t_ms - previous.t_ms) / 1000);
    const dist = haversineMeters(
      previous.fix.lat_deg,
      previous.fix.lon_deg,
      epoch.fix.lat_deg,
      epoch.fix.lon_deg,
    );
    const impliedSpeed = dist / dt_s;
    teleport = impliedSpeed > config.maxPlatformSpeed_mps * 1.5;
    indicators.push({
      id: "position_jump",
      detail: `Implied speed ${impliedSpeed.toFixed(0)} m/s over ${dt_s.toFixed(
        2,
      )} s vs envelope ${config.maxPlatformSpeed_mps} m/s.`,
      weight: 0.3,
      fired: teleport,
    });
  }

  // 3. Clock-bias discontinuity.
  let clockJump = false;
  if (previous) {
    const dClock = Math.abs(epoch.clock_bias_ns - previous.clock_bias_ns);
    clockJump = dClock > config.maxClockJump_ns;
    indicators.push({
      id: "clock_discontinuity",
      detail: `Clock-bias step ${dClock.toFixed(0)} ns vs limit ${config.maxClockJump_ns} ns.`,
      weight: 0.15,
      fired: clockJump,
    });
  }

  // 4. Collapsed Doppler diversity.
  const dopplerSpread = stddev(locked.map((o) => o.doppler_hz));
  const dopplerCollapse = locked.length >= 4 && dopplerSpread < 20;
  indicators.push({
    id: "doppler_collapse",
    detail: `Doppler spread ${dopplerSpread.toFixed(
      1,
    )} Hz (independent satellites show hundreds of Hz of diversity).`,
    weight: 0.15,
    fired: dopplerCollapse,
  });

  // 5. Per-constellation fix disagreement is handled by the caller when
  //    multiple independent fixes are available; exposed via helper below.

  const confidence = clamp01(
    indicators.reduce((acc, i) => acc + (i.fired ? i.weight : 0), 0),
  );
  return {
    kind: "spoofing",
    severity: severityFor(confidence),
    confidence,
    indicators,
  };
}

/**
 * Cross-check two independently computed fixes (e.g. GPS-only vs Galileo-only).
 * A spoofer that targets one constellation drives them apart. Returns the
 * separation in metres and whether it breaches the configured tolerance.
 */
export function constellationDisagreement(
  a: { lat_deg: number; lon_deg: number },
  b: { lat_deg: number; lon_deg: number },
  config: DefenseConfig = DEFAULT_CONFIG,
): { separation_m: number; breached: boolean } {
  const separation_m = haversineMeters(a.lat_deg, a.lon_deg, b.lat_deg, b.lon_deg);
  return {
    separation_m,
    breached: separation_m > config.maxConstellationDisagreement_m,
  };
}

function severityFor(confidence: number): Severity {
  if (confidence >= 0.6) return "critical";
  if (confidence >= 0.3) return "suspect";
  return "nominal";
}
