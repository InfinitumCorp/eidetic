// © Infinitum Corporation®. All rights reserved.

import { EideticError, type DenialCode } from "@eidetic/contracts";
import { assertDefensiveOnly, RF_DEFENSE_BOUNDARY } from "./boundary.js";

/**
 * Policy adapter for the API edge.
 *
 * `boundary.ts` enforces the defensive scope by throwing. This adapter wraps
 * that into a plain decision object so a request handler can branch without a
 * try/catch, and so the denial maps cleanly onto the shared @eidetic/contracts
 * DenialCode vocabulary the rest of the platform already speaks.
 *
 * It keeps the enforcement in ONE place: any route that might receive a
 * free-form RF action calls evaluateRfRequest() and honours the decision. There
 * is no code path here that performs an offensive action — only permits a
 * passive/defensive one or denies.
 */

export interface RfRequestDecision {
  allow: boolean;
  /** Present when denied; a shared platform denial code. */
  code?: DenialCode;
  /** HTTP status to surface (403 on denial). */
  httpStatus: number;
  /** Operator-facing explanation. */
  reason: string;
}

/** Evaluate a free-form RF action request against the defensive boundary. */
export function evaluateRfRequest(request: string): RfRequestDecision {
  try {
    const permitted = assertDefensiveOnly(request);
    return {
      allow: true,
      httpStatus: 200,
      reason: `Permitted passive/defensive action: "${permitted}".`,
    };
  } catch (err) {
    if (err instanceof EideticError) {
      return {
        allow: false,
        code: err.code,
        httpStatus: err.httpStatus,
        reason: err.message,
      };
    }
    throw err;
  }
}

/**
 * Enforce the decision: return the cleaned request when allowed, or throw the
 * same EideticError the boundary would, for handlers that prefer fail-fast.
 */
export function enforceRfRequest(request: string): string {
  return assertDefensiveOnly(request);
}

/** The human-readable scope statement, re-exported for API error surfaces. */
export const RF_POLICY_STATEMENT = RF_DEFENSE_BOUNDARY;
