// © Infinitum Corporation®. All rights reserved.

import { detectJamming } from "./jamming.js";
import { detectSpoofing } from "./gnss-integrity.js";
import {
  DEFAULT_CONFIG,
  type DefenseConfig,
  type DetectorVerdict,
  type GnssEpoch,
} from "./types.js";

/**
 * PNT (position/navigation/timing) integrity monitor.
 *
 * Runs the spoofing and jamming detectors per epoch and folds their verdicts
 * into a single trust state with hysteresis, plus a safe-fallback recommendation.
 * This is the "what should the platform DO" layer — it never touches RF.
 *
 *   TRUSTED   — use the GNSS fix normally.
 *   DEGRADED  — treat the fix as low-trust; blend/limit its authority.
 *   DENIED    — do not trust GNSS; fall back to an independent source
 *               (inertial / dead-reckoning / known-good hold).
 */
export type PntState = "TRUSTED" | "DEGRADED" | "DENIED";

export type PntRecommendation =
  | "USE_GNSS"
  | "BLEND_WITH_INERTIAL"
  | "FALLBACK_INERTIAL_DEAD_RECKONING";

export interface PntAssessment {
  t_ms: number;
  state: PntState;
  recommendation: PntRecommendation;
  spoofing: DetectorVerdict;
  jamming: DetectorVerdict;
  /** Operator-facing one-liner summarising why the state is what it is. */
  summary: string;
}

export interface MonitorOptions {
  config?: DefenseConfig;
  /**
   * Consecutive nominal epochs required before relaxing the state by one level.
   * Hysteresis stops a single clean epoch from clearing an active attack.
   */
  clearingEpochs?: number;
}

/**
 * Stateful monitor. Feed it epochs in time order; it returns an assessment for
 * each. Keeps only the previous epoch plus small counters — safe for long runs.
 */
export class PntIntegrityMonitor {
  private readonly config: DefenseConfig;
  private readonly clearingEpochs: number;
  private previous: GnssEpoch | null = null;
  private state: PntState = "TRUSTED";
  private cleanStreak = 0;

  constructor(options: MonitorOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.clearingEpochs = Math.max(1, options.clearingEpochs ?? 3);
  }

  assess(epoch: GnssEpoch): PntAssessment {
    const spoofing = detectSpoofing(epoch, this.previous, this.config);
    const jamming = detectJamming(epoch, this.previous, this.config);
    this.previous = epoch;

    const worst = Math.max(spoofing.confidence, jamming.confidence);
    const target = stateForConfidence(worst);

    if (rank(target) > rank(this.state)) {
      // Escalate immediately — threats take effect the instant they appear.
      this.state = target;
      this.cleanStreak = 0;
    } else if (rank(target) < rank(this.state)) {
      // De-escalate only after a sustained clean streak (hysteresis).
      this.cleanStreak += 1;
      if (this.cleanStreak >= this.clearingEpochs) {
        this.state = relax(this.state);
        this.cleanStreak = 0;
      }
    } else {
      this.cleanStreak = 0;
    }

    return {
      t_ms: epoch.t_ms,
      state: this.state,
      recommendation: recommend(this.state),
      spoofing,
      jamming,
      summary: summarise(this.state, spoofing, jamming),
    };
  }

  /** Current trust state without advancing the monitor. */
  get currentState(): PntState {
    return this.state;
  }
}

function stateForConfidence(c: number): PntState {
  if (c >= 0.6) return "DENIED";
  if (c >= 0.3) return "DEGRADED";
  return "TRUSTED";
}

function rank(s: PntState): number {
  return s === "TRUSTED" ? 0 : s === "DEGRADED" ? 1 : 2;
}

function relax(s: PntState): PntState {
  return s === "DENIED" ? "DEGRADED" : "TRUSTED";
}

function recommend(s: PntState): PntRecommendation {
  if (s === "DENIED") return "FALLBACK_INERTIAL_DEAD_RECKONING";
  if (s === "DEGRADED") return "BLEND_WITH_INERTIAL";
  return "USE_GNSS";
}

function summarise(
  state: PntState,
  spoofing: DetectorVerdict,
  jamming: DetectorVerdict,
): string {
  if (state === "TRUSTED") return "GNSS nominal; no attack indicators above threshold.";
  const lead =
    spoofing.confidence >= jamming.confidence
      ? `spoofing (${(spoofing.confidence * 100).toFixed(0)}%)`
      : `jamming (${(jamming.confidence * 100).toFixed(0)}%)`;
  const firedIds = [...spoofing.indicators, ...jamming.indicators]
    .filter((i) => i.fired)
    .map((i) => i.id);
  return `${state}: leading threat ${lead}. Indicators: ${firedIds.join(", ") || "none"}.`;
}
