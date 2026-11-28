// © Infinitum Corporation®. All rights reserved.

/**
 * @eidetic/eon-rf-defense
 *
 * DEFENSIVE PNT (position/navigation/timing) integrity for EON.
 *
 * Detects GNSS jamming and spoofing attacks against EON's OWN receivers from
 * the receiver's OWN telemetry, scores them, and recommends a safe fallback.
 * It is strictly passive: no transmit, no jamming, no spoofing, no interception
 * of anyone's communications. Offensive/intercept requests fail closed — see
 * ./boundary.ts (and the refusal posture of @eidetic/geo and @eidetic/mil).
 */

export {
  RF_DEFENSE_BOUNDARY,
  assertDefensiveOnly,
  refuseOffensiveRf,
} from "./boundary.js";

export {
  DEFAULT_CONFIG,
  type Constellation,
  type DefenseConfig,
  type DetectorVerdict,
  type GnssEpoch,
  type GnssObservable,
  type Indicator,
  type NavFix,
  type RfFrontEnd,
  type Severity,
} from "./types.js";

export { detectSpoofing, constellationDisagreement } from "./gnss-integrity.js";
export { detectJamming } from "./jamming.js";
export {
  PntIntegrityMonitor,
  type MonitorOptions,
  type PntAssessment,
  type PntRecommendation,
  type PntState,
} from "./pnt.js";
export {
  nominalScenario,
  spoofedScenario,
  jammedScenario,
  type ScenarioOptions,
} from "./simulate.js";
export { analyzeRun, type RunReport } from "./analyze.js";
export {
  NavMessageAuthenticator,
  buildTestChain,
  computeMac,
  hashChain,
  verifyKeyAgainstAnchor,
  verifyMac,
  DEFAULT_AUTH_CONFIG,
  type AuthConfig,
  type HashName,
  type NavRecord,
  type VerificationResult,
} from "./osnma.js";
export {
  DeadReckoner,
  deadReckon,
  DEFAULT_DR_CONFIG,
  type DeadReckonConfig,
  type DeadReckonState,
  type ImuSample,
} from "./inertial.js";
export { toNdjson, toCsv, digestLine, type ExportRow } from "./export.js";
export {
  evaluateRfRequest,
  enforceRfRequest,
  RF_POLICY_STATEMENT,
  type RfRequestDecision,
} from "./policy.js";
