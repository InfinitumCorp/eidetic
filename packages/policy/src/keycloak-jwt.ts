// © Infinitum Corporation®. All rights reserved.

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { Role } from "@eidetic/contracts";
import { mapVerifiedKeycloakClaims } from "./index.js";

export interface VerifiedKeycloakActor {
  role: Role;
  subject: string;
}

export interface KeycloakVerifyOptions {
  issuer: string;
  audience: string;
  jwks: JSONWebKeySet | string;
}

/**
 * Verify a Keycloak access token with jose (MIT).
 * Signature, issuer, audience, and expiry are all required. Any failure returns null.
 */
export async function verifyKeycloakAccessToken(token: string, options: KeycloakVerifyOptions): Promise<VerifiedKeycloakActor | null> {
  try {
    const key = typeof options.jwks === "string"
      ? createRemoteJWKSet(new URL(options.jwks))
      : createLocalJWKSet(options.jwks);
    const { payload } = await jwtVerify(token, key, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["RS256", "ES256"],
    });
    return actorFromPayload(payload, options.issuer);
  } catch {
    return null;
  }
}

function actorFromPayload(payload: JWTPayload, issuer: string): VerifiedKeycloakActor | null {
  const realmAccess = payload.realm_access;
  const roles = realmAccess && typeof realmAccess === "object" && Array.isArray((realmAccess as { roles?: unknown }).roles)
    ? ((realmAccess as { roles: unknown[] }).roles.filter((role) => typeof role === "string") as string[])
    : [];
  const role = mapVerifiedKeycloakClaims(
    {
      iss: typeof payload.iss === "string" ? payload.iss : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
      realm_access: { roles },
    },
    issuer,
  );
  if (!role || typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  return { role, subject: payload.sub };
}
