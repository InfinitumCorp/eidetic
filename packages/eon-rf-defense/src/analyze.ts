// © Infinitum Corporation®. All rights reserved.

import { PntIntegrityMonitor, type MonitorOptions, type PntAssessment, type PntState } from "./pnt.js";
import type { GnssEpoch } from "./types.js";

/**
 * After-action analysis.
 *
 * Replays a captured epoch stream through the PntIntegrityMonitor and folds the
 * per-epoch assessments into one operator-facing report: when GNSS first became
 * untrusted, when it was denied, how long the platform spent in each trust
 * state, and the peak threat confidence seen. Pure analysis of EON's own logged
 * telemetry — no RF, consistent with the package boundary.
 */
export interface RunReport {
  epochs: number;
  span_ms: number;
  /** First epoch time where the state left TRUSTED, or null if never. */
  firstUntrustedAt_ms: number | null;
  /** First epoch time where the state reached DENIED, or null if never. */
  firstDeniedAt_ms: number | null;
  /** Milliseconds spent in each trust state (by epoch interval). */
  dwell_ms: Record<PntState, number>;
  peakSpoofConfidence: number;
  peakJamConfidence: number;
  leadingThreat: "spoofing" | "jamming" | "none";
  /** Per-epoch assessments in time order. */
  timeline: PntAssessment[];
  summary: string;
}

export function analyzeRun(
  epochs: readonly GnssEpoch[],
  options: MonitorOptions = {},
): RunReport {
  const monitor = new PntIntegrityMonitor(options);
  const timeline: PntAssessment[] = [];
  for (const epoch of epochs) timeline.push(monitor.assess(epoch));

  const dwell_ms: Record<PntState, number> = { TRUSTED: 0, DEGRADED: 0, DENIED: 0 };
  let firstUntrustedAt_ms: number | null = null;
  let firstDeniedAt_ms: number | null = null;
  let peakSpoofConfidence = 0;
  let peakJamConfidence = 0;

  for (let i = 0; i < timeline.length; i++) {
    const a = timeline[i]!;
    // Interval this assessment "covers": gap to the next epoch (0 for the last).
    const next = timeline[i + 1];
    const interval = next ? Math.max(0, next.t_ms - a.t_ms) : 0;
    dwell_ms[a.state] += interval;

    if (a.state !== "TRUSTED" && firstUntrustedAt_ms === null) {
      firstUntrustedAt_ms = a.t_ms;
    }
    if (a.state === "DENIED" && firstDeniedAt_ms === null) {
      firstDeniedAt_ms = a.t_ms;
    }
    peakSpoofConfidence = Math.max(peakSpoofConfidence, a.spoofing.confidence);
    peakJamConfidence = Math.max(peakJamConfidence, a.jamming.confidence);
  }

  const span_ms =
    timeline.length > 0 ? timeline[timeline.length - 1]!.t_ms - timeline[0]!.t_ms : 0;

  let leadingThreat: RunReport["leadingThreat"] = "none";
  if (firstUntrustedAt_ms !== null) {
    leadingThreat = peakSpoofConfidence >= peakJamConfidence ? "spoofing" : "jamming";
  }

  return {
    epochs: timeline.length,
    span_ms,
    firstUntrustedAt_ms,
    firstDeniedAt_ms,
    dwell_ms,
    peakSpoofConfidence,
    peakJamConfidence,
    leadingThreat,
    timeline,
    summary: summarise({
      epochs: timeline.length,
      firstUntrustedAt_ms,
      firstDeniedAt_ms,
      leadingThreat,
      dwell_ms,
    }),
  };
}

function summarise(r: {
  epochs: number;
  firstUntrustedAt_ms: number | null;
  firstDeniedAt_ms: number | null;
  leadingThreat: RunReport["leadingThreat"];
  dwell_ms: Record<PntState, number>;
}): string {
  if (r.firstUntrustedAt_ms === null) {
    return `${r.epochs} epochs: GNSS TRUSTED throughout; no jamming or spoofing indicators above threshold.`;
  }
  const denied =
    r.firstDeniedAt_ms !== null ? `, denied at t=${r.firstDeniedAt_ms} ms` : "";
  return `${r.epochs} epochs: ${r.leadingThreat} detected; first untrusted at t=${r.firstUntrustedAt_ms} ms${denied}. Dwell — TRUSTED ${r.dwell_ms.TRUSTED} ms / DEGRADED ${r.dwell_ms.DEGRADED} ms / DENIED ${r.dwell_ms.DENIED} ms.`;
}
