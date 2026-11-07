// © Infinitum Corporation®. All rights reserved.

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyKeycloakAccessToken } from "./keycloak-jwt.js";

const issuer = "https://idp.example/realms/eidetic";
const audience = "eidetic-api";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const other = await generateKeyPair("RS256", { extractable: true });
  return { privateKey, otherKey: other.privateKey, jwks: { keys: [jwk] } };
}

async function token(key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"], claims: Record<string, unknown>, exp = "2m") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

describe("Keycloak JWT verification", () => {
  it("accepts a token signed by the test JWKS and rejects bad signature, issuer, audience, and expiry", async () => {
    const { privateKey, otherKey, jwks } = await fixture();
    const accepted = await verifyKeycloakAccessToken(
      await token(privateKey, { realm_access: { roles: ["eidetic-reviewer"] } }),
      { issuer, audience, jwks },
    );
    expect(accepted).toEqual({ role: "reviewer", subject: "user-1" });

    expect(await verifyKeycloakAccessToken(await token(otherKey, { realm_access: { roles: ["eidetic-reviewer"] } }), { issuer, audience, jwks })).toBeNull();
    expect(
      await verifyKeycloakAccessToken(await token(privateKey, { realm_access: { roles: ["eidetic-reviewer"] } }), {
        issuer: "https://idp.example/realms/other",
        audience,
        jwks,
      }),
    ).toBeNull();
    expect(
      await verifyKeycloakAccessToken(await token(privateKey, { realm_access: { roles: ["eidetic-reviewer"] } }), {
        issuer,
        audience: "another-app",
        jwks,
      }),
    ).toBeNull();
    expect(await verifyKeycloakAccessToken(await token(privateKey, { realm_access: { roles: ["eidetic-reviewer"] } }, "-1m"), { issuer, audience, jwks })).toBeNull();
    expect(await verifyKeycloakAccessToken(await token(privateKey, { realm_access: { roles: ["eidetic-admin", "eidetic-operator"] } }), { issuer, audience, jwks })).toBeNull();
    expect(await verifyKeycloakAccessToken("not-a-jwt", { issuer, audience, jwks })).toBeNull();
  });
});
