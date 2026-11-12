// © Infinitum Corporation®. All rights reserved.

import {
  DEFAULT_CONFIG,
  type DefenseConfig,
  type DetectorVerdict,
  type GnssEpoch,
  type Indicator,
  type Severity,
} from "./types.js";
import { clamp01, mean } from "./stats.js";

/**
 * GNSS / RF jamming detection.
 *
 * A jammer raises in-band noise so the receiver loses lock. Unlike spoofing,
 * the tell-tale is LOSS of signal, not false-but-strong signal:
 *
 *   1. AGC drives toward the rail trying to ride out the noise.
 *   2. The estimated noise floor rises above the quiet-sky alarm level.
 *   3. Mean C/N0 on still-locked channels collapses toward the floor.
 *   4. The count of locked channels drops sharply versus the previous epoch.
 *
 * Reported severity rises with how many independent indicators agree.
 */
export function detectJamming(
  epoch: GnssEpoch,
  previous: GnssEpoch | null,
  config: DefenseConfig = DEFAULT_CONFIG,
): DetectorVerdict {
  const indicators: Indicator[] = [];
  const locked = epoch.observables.filter((o) => o.locked);

  // 1. AGC saturation.
  const agcSaturated = epoch.frontEnd.agc_level >= config.agcSaturation;
  indicators.push({
    id: "agc_saturation",
    detail: `AGC ${(epoch.frontEnd.agc_level * 100).toFixed(
      0,
    )}% vs saturation ${(config.agcSaturation * 100).toFixed(0)}%.`,
    weight: 0.3,
    fired: agcSaturated,
  });

  // 2. Noise floor rise.
  const noisy = epoch.frontEnd.noise_floor_dbm > config.noiseFloorAlarm_dbm;
  indicators.push({
    id: "noise_floor_rise",
    detail: `Noise floor ${epoch.frontEnd.noise_floor_dbm.toFixed(
      1,
    )} dBm vs alarm ${config.noiseFloorAlarm_dbm} dBm.`,
    weight: 0.3,
    fired: noisy,
  });

  // 3. C/N0 collapse on surviving channels.
  const cn0Mean = locked.length > 0 ? mean(locked.map((o) => o.cn0_dbhz)) : 0;
  const cn0Collapsed = locked.length === 0 || cn0Mean < config.jamCn0Floor_dbhz;
  indicators.push({
    id: "cn0_collapse",
    detail: `Mean C/N0 ${cn0Mean.toFixed(1)} dB-Hz on ${
      locked.length
    } locked channel(s) vs floor ${config.jamCn0Floor_dbhz} dB-Hz.`,
    weight: 0.25,
    fired: cn0Collapsed,
  });

  // 4. Sudden loss of locks.
  let lockLoss = false;
  if (previous) {
    const prevLocked = previous.observables.filter((o) => o.locked).length;
    lockLoss = prevLocked >= 4 && locked.length <= Math.floor(prevLocked / 2);
    indicators.push({
      id: "lock_loss",
      detail: `Locked channels ${prevLocked} -> ${locked.length} between epochs.`,
      weight: 0.15,
      fired: lockLoss,
    });
  }

  const confidence = clamp01(
    indicators.reduce((acc, i) => acc + (i.fired ? i.weight : 0), 0),
  );
  return {
    kind: "jamming",
    severity: severityFor(confidence),
    confidence,
    indicators,
  };
}

function severityFor(confidence: number): Severity {
  if (confidence >= 0.6) return "critical";
  if (confidence >= 0.3) return "suspect";
  return "nominal";
}
