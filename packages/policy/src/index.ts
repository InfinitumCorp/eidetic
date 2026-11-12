// © Infinitum Corporation®. All rights reserved.

import {
  OUT_OF_SCOPE_PATTERN,
  isDenialCode,
  type Actor,
  type DenialCode,
  type Edition,
  type LegalBasis,
  type PurposeDefinition,
  type Role,
} from "@eidetic/contracts";
import { evaluateMilEdition } from "@eidetic/mil";

export interface PolicyInput {
  actor: Actor;
  purpose: PurposeDefinition | null;
  legalBasis: LegalBasis;
  datasetId: string;
  edition: Edition;
  milEnabled: boolean;
  /** Present when the caller already resolved a specific subject. Omitted for a 1:N gallery filter. */
  consent?: { state: "granted" | "withdrawn" | "expired" | "missing" | "not_enrolled"; label?: string };
}

export type PolicyDecision = { allow: true } | { allow: false; code: DenialCode; message: string };

export interface PolicyDecider {
  decide(input: PolicyInput): Promise<PolicyDecision>;
}

function deny(code: DenialCode, message: string): PolicyDecision {
  return { allow: false, code, message };
}

export function authorizeSearch(input: PolicyInput): PolicyDecision {
  const mil = evaluateMilEdition(input.edition, input.milEnabled);
  if (mil.blocked) return deny(mil.code, mil.message);
  if (!input.purpose) {
    return deny(
      "PURPOSE_UNKNOWN",
      "Search refused. No enrolled purpose matches this request. ei·det·ic™ fails closed and did not run a match.",
    );
  }
  if (
    OUT_OF_SCOPE_PATTERN.test(input.purpose.code) ||
    OUT_OF_SCOPE_PATTERN.test(input.purpose.title) ||
    OUT_OF_SCOPE_PATTERN.test(input.datasetId)
  ) {
    return deny(
      "FORBIDDEN",
      "Search refused. This purpose is outside civilian and business consent-based use. The match did not run.",
    );
  }
  if (!input.purpose.active) {
    return deny("PURPOSE_INACTIVE", "Search refused. This purpose is inactive. The match did not run.");
  }
  if (input.purpose.edition !== input.edition) {
    return deny(
      "EDITION_MISMATCH",
      `Search refused. Purpose ${input.purpose.code} belongs to the ${input.purpose.edition} edition. The match did not run.`,
    );
  }
  if (!input.purpose.allowedRoles.includes(input.actor.role)) {
    return deny(
      "ROLE_NOT_PERMITTED",
      `Search refused. Role ${input.actor.role} cannot run purpose ${input.purpose.code}. The match did not run.`,
    );
  }
  if (!input.purpose.legalBases.includes(input.legalBasis)) {
    return deny(
      "LEGAL_BASIS_REJECTED",
      `Search refused. Legal basis ${input.legalBasis} is not approved for ${input.purpose.code}. The match did not run.`,
    );
  }
  if (!input.purpose.datasetIds.includes(input.datasetId)) {
    return deny(
      "DATASET_OUT_OF_SCOPE",
      `Search refused. Dataset ${input.datasetId} is outside purpose ${input.purpose.code}. The match did not run.`,
    );
  }
  if (input.consent?.state === "not_enrolled") {
    return deny("SUBJECT_NOT_ENROLLED", "Search refused. That CID is not enrolled. The match did not run.");
  }
  if (input.consent?.state === "withdrawn") {
    return deny(
      "CONSENT_WITHDRAWN",
      `Search refused. ${input.consent.label ?? "The subject"} withdrew consent. The match did not run.`,
    );
  }
  if (input.consent?.state === "expired") {
    return deny(
      "CONSENT_EXPIRED",
      `Search refused. ${input.consent.label ?? "The subject"}'s consent for this purpose has expired. The match did not run.`,
    );
  }
  if (input.consent?.state === "missing") {
    return deny(
      "CONSENT_REQUIRED",
      "Search refused. This subject has not granted consent for this purpose and dataset. The match did not run.",
    );
  }
  return { allow: true };
}

/** Default in-process decider. Same rules as deploy/opa/eidetic.rego, evaluated here when OPA_URL is unset. */
export class EmbeddedPolicyDecider implements PolicyDecider {
  decide(input: PolicyInput): Promise<PolicyDecision> {
    return Promise.resolve(authorizeSearch(input));
  }
}

export class LocalPolicyDecider implements PolicyDecider {
  decide(input: PolicyInput): Promise<PolicyDecision> {
    return Promise.resolve(authorizeSearch(input));
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thin client for an Open Policy Agent deployment. Unreachable OPA fails closed. */
export class OpaPolicyDecider implements PolicyDecider {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private endpoint(): string {
    const trimmed = this.url.replace(/\/$/, "");
    if (trimmed.endsWith("/v1/data/eidetic/authorize")) return trimmed;
    return `${trimmed}/v1/data/eidetic/authorize`;
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
    } catch {
      return deny("POLICY_UNAVAILABLE", "OPA was unreachable. ei·det·ic™ failed closed and did not run a search.");
    }
    if (!response.ok) {
      return deny("POLICY_UNAVAILABLE", "OPA did not accept the decision request. The search did not run.");
    }
    const body = (await response.json()) as { result?: { allow?: boolean; code?: unknown; message?: unknown } };
    if (body.result?.allow === true) return { allow: true };
    const code = isDenialCode(body.result?.code) ? body.result.code : "FORBIDDEN";
    const message =
      typeof body.result?.message === "string"
        ? body.result.message
        : "OPA did not allow this search. The match did not run.";
    return deny(code, message);
  }
}

const KEYCLOAK_ROLE_MAP: Record<string, Role> = {
  "eidetic-admin": "admin",
  "eidetic-operator": "operator",
  "eidetic-reviewer": "reviewer",
  "eidetic-auditor": "auditor",
};

/**
 * Maps one Keycloak realm role onto one ei·det·ic™ role.
 * Call this only after verifyKeycloakAccessToken has checked the signature.
 */
export interface KeycloakAccessClaims {
  iss?: string;
  exp?: number;
  realm_access?: { roles?: string[] };
}

/**
 * Map claims that a Keycloak JWKS verifier has already signed-checked.
 * This function does not validate a signature. Production must do that
 * against the realm's JWKS before these claims are trusted.
 */
export function mapVerifiedKeycloakClaims(claims: KeycloakAccessClaims, expectedIssuer: string, nowMs = Date.now()): Role | null {
  if (!claims.iss || claims.iss !== expectedIssuer) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  return mapKeycloakRoles(claims.realm_access?.roles ?? []);
}

export { verifyKeycloakAccessToken } from "./keycloak-jwt.js";

export function mapKeycloakRoles(realmRoles: readonly string[]): Role | null {
  const mapped = realmRoles
    .map((role) => KEYCLOAK_ROLE_MAP[role])
    .filter((role): role is Role => Boolean(role));
  const unique = [...new Set(mapped)];
  return unique.length === 1 ? unique[0] : null;
}
