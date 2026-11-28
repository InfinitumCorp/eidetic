// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { readCidConfig } from "./cid.js";
import { readEnv } from "./env.js";
import { assertProductionConfig } from "./startup.js";

describe("production startup guards", () => {
  it("refuses non-demo mode without an audit key and a Cumulus ID admin", () => {
    const env = readEnv();
    env.demoMode = false;
    env.auditSigner = "env";
    env.auditPrivateKeyPem = undefined;
    env.auditKeyPath = undefined;
    env.devBearer = false;
    env.cid = readCidConfig({});
    expect(() => assertProductionConfig(env)).toThrow(/Refusing to start/);
    env.auditSigner = "openbao";
    env.openbaoAddr = "http://127.0.0.1:8200";
    env.openbaoToken = "token";
    expect(() => assertProductionConfig(env)).toThrow(/CID_ADMINS/);
    env.cid = readCidConfig({ CID_REVIEWERS: "reviewer-cid" });
    expect(() => assertProductionConfig(env)).toThrow(/CID_ADMINS/);
    env.cid = readCidConfig({ CID_ADMINS: "admin-cid" });
    expect(() => assertProductionConfig(env)).not.toThrow();
  });

  it("refuses the dev bearer bypass outside demo mode", () => {
    const env = readEnv();
    env.demoMode = false;
    env.devBearer = true;
    expect(() => assertProductionConfig(env)).toThrow(/EIDETIC_DEV_BEARER/);
  });

  it("refuses demo mode when NODE_ENV=production", () => {
    const before = process.env.NODE_ENV;
    try {
      const env = readEnv();
      env.demoMode = true;
      env.devBearer = false;
      process.env.NODE_ENV = "production";
      expect(() => assertProductionConfig(env)).toThrow(/Set DEMO_MODE=false for production/);
      process.env.NODE_ENV = "development";
      expect(() => assertProductionConfig(env)).not.toThrow();
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});
