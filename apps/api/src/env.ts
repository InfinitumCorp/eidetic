// © Infinitum Corporation®. All rights reserved.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readCidConfig, type CidConfig } from "./cid.js";
export interface Env {
  port: number;
  databaseUrl: string;
  biometricStorePath: string;
  matcherMode: "mock" | "insightface" | "opencv-zoo";
  captureProvider: "local" | "opencv-mediapipe";
  opencvZooModelDir: string;
  milEnabled: boolean;
  demoMode: boolean;
  insightfaceLicenseAccepted: boolean;
  insightfaceUrl?: string;
  opencvMediapipeUrl?: string;
  allowOperatorCaptures: boolean;
  auditSigner: "env" | "openbao";
  openbaoAddr?: string;
  openbaoToken?: string;
  openbaoTransitKey: string;
  auditPrivateKeyPem?: string;
  auditKeyPath?: string;
  demoKeyPath: string;
  opaUrl?: string;
  fidesUrl?: string;
  presidioUrl?: string;
  keycloakIssuer?: string;
  keycloakAudience?: string;
  keycloakJwksUrl?: string;
  /** People sign in with Cumulus ID. Issuer and CID-to-role lists. */
  cid: CidConfig;
  /** Local development only: accept the seeded dev-* bearer tokens. Needs DEMO_MODE=true. */
  devBearer: boolean;
  migrationsDir: string;
  /** ALLOWED_ORIGINS: comma-separated browser origins for CORS. Unset keeps the local desks. */
  allowedOrigins?: string[];
}

export function loadEnvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../.env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

export function readEnv(): Env {
  loadEnvFile();
  const matcherMode = process.env.MATCHER_MODE ?? "mock";
  if (matcherMode !== "mock" && matcherMode !== "insightface" && matcherMode !== "opencv-zoo") {
    throw new Error("MATCHER_MODE must be mock, opencv-zoo, or insightface");
  }
  const captureProvider = process.env.CAPTURE_PROVIDER ?? "local";
  if (captureProvider !== "local" && captureProvider !== "opencv-mediapipe") {
    throw new Error("CAPTURE_PROVIDER must be local or opencv-mediapipe");
  }
  const auditSigner = process.env.AUDIT_SIGNER === "openbao" ? "openbao" : "env";
  return {
    port: Number(process.env.PORT ?? 43110),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://eidetic:eidetic@127.0.0.1:5432/eidetic",
    biometricStorePath: resolveStorePath(process.env.BIOMETRIC_STORE_PATH ?? "data/templates"),
    matcherMode,
    captureProvider,
    opencvZooModelDir: resolveStorePath(process.env.OPENCV_ZOO_MODEL_DIR ?? "data/models/opencv-zoo"),
    milEnabled: process.env.MIL_ENABLED === "true",
    demoMode: process.env.DEMO_MODE !== "false",
    insightfaceLicenseAccepted: process.env.INSIGHTFACE_LICENSE_ACCEPTED === "true",
    insightfaceUrl: emptyToUndefined(process.env.INSIGHTFACE_URL),
    opencvMediapipeUrl: emptyToUndefined(process.env.OPENCV_MEDIAPIPE_URL),
    allowOperatorCaptures: process.env.EIDETIC_ALLOW_OPERATOR_CAPTURES === "true",
    auditSigner,
    openbaoAddr: emptyToUndefined(process.env.OPENBAO_ADDR),
    openbaoToken: emptyToUndefined(process.env.OPENBAO_TOKEN),
    openbaoTransitKey: process.env.OPENBAO_TRANSIT_KEY?.trim() || "eidetic-audit",
    auditPrivateKeyPem: emptyToUndefined(process.env.AUDIT_ED25519_PRIVATE_KEY),
    auditKeyPath: emptyToUndefined(process.env.AUDIT_ED25519_KEY_PATH),
    demoKeyPath: resolveStorePath("data/audit-ed25519.pem"),
    opaUrl: emptyToUndefined(process.env.OPA_URL),
    fidesUrl: emptyToUndefined(process.env.FIDES_URL),
    presidioUrl: emptyToUndefined(process.env.PRESIDIO_URL),
    keycloakIssuer: emptyToUndefined(process.env.KEYCLOAK_ISSUER),
    keycloakAudience: emptyToUndefined(process.env.KEYCLOAK_AUDIENCE),
    keycloakJwksUrl: emptyToUndefined(process.env.KEYCLOAK_JWKS_URL),
    cid: readCidConfig(process.env),
    devBearer: process.env.EIDETIC_DEV_BEARER === "true",
    migrationsDir: process.env.MIGRATIONS_DIR ?? findMigrations(),
    allowedOrigins: readAllowedOrigins(process.env.ALLOWED_ORIGINS),
  };
}

export function readAllowedOrigins(value: string | undefined): string[] | undefined {
  const items = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  for (const item of items) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`ALLOWED_ORIGINS has an entry that is not a URL: ${item}`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== item) {
      throw new Error(`ALLOWED_ORIGINS entries must be bare origins like https://desk.example.com, not ${item}`);
    }
  }
  return items;
}

function resolveStorePath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const root = process.cwd().endsWith(`${path.sep}apps${path.sep}api`)
    ? path.resolve(process.cwd(), "../..")
    : process.cwd();
  return path.resolve(root, value);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function findMigrations(): string {
  const candidates = [
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "apps/api/migrations"),
    path.resolve(process.cwd(), "src/../migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find SQL migrations. Set MIGRATIONS_DIR.");
}
