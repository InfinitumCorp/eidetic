// © Infinitum Corporation®. All rights reserved.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  createEd25519SignerFromPem,
  createOpenBaoTransitSigner,
  type CheckpointSigner,
} from "@eidetic/audit";
import type { Env } from "./env.js";

export function assertProductionConfig(env: Env): void {
  if (env.devBearer && !env.demoMode) {
    throw new Error("EIDETIC_DEV_BEARER is a local development bypass. It is refused while DEMO_MODE is false.");
  }
  if (env.devBearer && process.env.NODE_ENV === "production") {
    throw new Error("EIDETIC_DEV_BEARER is a local development bypass. It is refused when NODE_ENV=production.");
  }
  if (env.demoMode) return;
  const hasOpenBao = env.auditSigner === "openbao" && Boolean(env.openbaoAddr && env.openbaoToken);
  const hasKey = Boolean(env.auditPrivateKeyPem || env.auditKeyPath);
  if (!hasOpenBao && !hasKey) {
    throw new Error(
      "DEMO_MODE is false. Refusing to start without OpenBao Transit or an Ed25519 private key. The development HMAC key is not accepted.",
    );
  }
  if (![...env.cid.roles.values()].includes("admin")) {
    throw new Error("DEMO_MODE is false. People sign in with Cumulus ID: set CID_ADMINS (and CID_REVIEWERS, CID_OPERATORS, CID_AUDITORS) to their Cumulus IDs.");
  }
}

export function resolveAuditSigner(env: Env): CheckpointSigner {
  assertProductionConfig(env);
  if (env.auditSigner === "openbao") {
    if (!env.openbaoAddr || !env.openbaoToken) {
      throw new Error("AUDIT_SIGNER=openbao requires OPENBAO_ADDR and OPENBAO_TOKEN.");
    }
    return createOpenBaoTransitSigner({
      address: env.openbaoAddr,
      token: env.openbaoToken,
      keyName: env.openbaoTransitKey,
    });
  }
  if (env.auditPrivateKeyPem) return createEd25519SignerFromPem(env.auditPrivateKeyPem);
  if (env.auditKeyPath) {
    if (!existsSync(env.auditKeyPath)) throw new Error(`Ed25519 key file not found at ${env.auditKeyPath}.`);
    return createEd25519SignerFromPem(readFileSync(env.auditKeyPath, "utf8"));
  }
  if (!env.demoMode) {
    throw new Error("DEMO_MODE is false. Refusing to mint a development audit key.");
  }
  return createEd25519SignerFromPem(loadOrCreateDemoKey(env.demoKeyPath));
}

function loadOrCreateDemoKey(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8");
  mkdirSync(path.dirname(file), { recursive: true });
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(file, pem, { mode: 0o600 });
  console.log(JSON.stringify({ level: "warn", msg: "Wrote a demo Ed25519 audit key. It is not for a shared deployment.", path: file }));
  return pem;
}
