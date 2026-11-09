// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { readEnv } from "./env.js";
import { assertProductionConfig } from "./startup.js";

describe("production startup guards", () => {
  it("refuses non-demo mode without an audit key and a Keycloak audience", () => {
    const env = readEnv();
    env.demoMode = false;
    env.auditSigner = "env";
    env.auditPrivateKeyPem = undefined;
    env.auditKeyPath = undefined;
    env.keycloakIssuer = undefined;
    env.keycloakAudience = undefined;
    expect(() => assertProductionConfig(env)).toThrow(/Refusing to start/);
    env.auditSigner = "openbao";
    env.openbaoAddr = "http://127.0.0.1:8200";
    env.openbaoToken = "token";
    expect(() => assertProductionConfig(env)).toThrow(/KEYCLOAK_ISSUER/);
    env.keycloakIssuer = "https://idp.example/realms/eidetic";
    env.keycloakAudience = "eidetic-api";
    expect(() => assertProductionConfig(env)).not.toThrow();
  });

  it("keeps cyber geo off unless INFINITUM_GEO_ENABLED is true", () => {
    const previous = process.env.INFINITUM_GEO_ENABLED;
    try {
      delete process.env.INFINITUM_GEO_ENABLED;
      expect(readEnv().infinitumGeoEnabled).toBe(false);
      process.env.INFINITUM_GEO_ENABLED = "false";
      expect(readEnv().infinitumGeoEnabled).toBe(false);
      process.env.INFINITUM_GEO_ENABLED = "true";
      expect(readEnv().infinitumGeoEnabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.INFINITUM_GEO_ENABLED;
      else process.env.INFINITUM_GEO_ENABLED = previous;
    }
  });
});
