// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";

/**
 * EON RF-Defense scope boundary.
 *
 * This package protects EON's own position/navigation/timing (PNT) against
 * jamming and spoofing. It is strictly passive and analytical:
 *
 *   ALLOWED  — reading EON's own receiver telemetry, scoring it for attack
 *              indicators, and recommending a safe fallback (e.g. inertial).
 *
 *   REFUSED  — anything that transmits, jams, spoofs, deauths, injects, or
 *              intercepts a third party's signals or communications. There is
 *              no transmit path in this package and there never will be one.
 *
 * This mirrors the refusal posture already used by @eidetic/geo and
 * @eidetic/mil: the capability is a boundary, and out-of-scope requests fail
 * closed rather than degrade into something harmful.
 */
export const RF_DEFENSE_BOUNDARY =
  "EON RF-Defense is passive and defensive. It detects jamming/spoofing against EON's own receivers. It does not transmit, jam, spoof, or intercept.";

const OFFENSIVE_RF_REQUEST =
  /\b(jam|jamming|jammer|spoof|spoofing|spoofer|deauth|transmit|broadcast|emit|inject(?:ion)?|intercept|wiretap|sigint|comint|elint|eavesdrop|exfiltrat)/i;

/**
 * Guard for any string that names an operation before it runs. Throws on an
 * offensive/interception request; returns the (trimmed) string otherwise.
 *
 * Use this at the edge of any adapter that might be handed a free-form action.
 */
export function assertDefensiveOnly(request: string): string {
  if (OFFENSIVE_RF_REQUEST.test(request)) {
    throw new EideticError(
      "FORBIDDEN",
      `${RF_DEFENSE_BOUNDARY} Refused request: "${request}".`,
      403,
      false,
    );
  }
  return request.trim();
}

/** Hard stop for code paths that should never be reachable in a defensive build. */
export function refuseOffensiveRf(what: string): never {
  throw new EideticError(
    "FORBIDDEN",
    `${RF_DEFENSE_BOUNDARY} "${what}" is not implemented and is out of scope.`,
    403,
    false,
  );
}
