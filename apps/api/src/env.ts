// © Infinitum Corporation®. All rights reserved.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEV_AUDIT_SIGNING_KEY } from "@eidetic/audit";

export interface Env {
  port: number;
  databaseUrl: string;
  biometricStorePath: string;
  matcherMode: "mock" | "insightface";
  captureProvider: "local" | "opencv-mediapipe";
  milEnabled: boolean;
  demoMode: boolean;
  insightfaceLicenseAccepted: boolean;
  insightfaceUrl?: string;
  opencvMediapipeUrl?: string;
  allowOperatorCaptures: boolean;
  auditSigningKey: string;
  auditSigningKeyIsDev: boolean;
  opaUrl?: string;
  fidesUrl?: string;
  presidioUrl?: string;
  keycloakIssuer?: string;
  migrationsDir: string;
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
  if (matcherMode !== "mock" && matcherMode !== "insightface") {
    throw new Error("MATCHER_MODE must be mock or insightface");
  }
  const captureProvider = process.env.CAPTURE_PROVIDER ?? "local";
  if (captureProvider !== "local" && captureProvider !== "opencv-mediapipe") {
    throw new Error("CAPTURE_PROVIDER must be local or opencv-mediapipe");
  }
  const auditSigningKey = process.env.AUDIT_SIGNING_KEY?.trim() || DEV_AUDIT_SIGNING_KEY;
  return {
    port: Number(process.env.PORT ?? 43110),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://eidetic:eidetic@127.0.0.1:5432/eidetic",
    biometricStorePath: resolveStorePath(process.env.BIOMETRIC_STORE_PATH ?? "data/templates"),
    matcherMode,
    captureProvider,
    milEnabled: process.env.MIL_ENABLED === "true",
    demoMode: process.env.DEMO_MODE !== "false",
    insightfaceLicenseAccepted: process.env.INSIGHTFACE_LICENSE_ACCEPTED === "true",
    insightfaceUrl: emptyToUndefined(process.env.INSIGHTFACE_URL),
    opencvMediapipeUrl: emptyToUndefined(process.env.OPENCV_MEDIAPIPE_URL),
    allowOperatorCaptures: process.env.EIDETIC_ALLOW_OPERATOR_CAPTURES === "true",
    auditSigningKey,
    auditSigningKeyIsDev: !process.env.AUDIT_SIGNING_KEY?.trim(),
    opaUrl: emptyToUndefined(process.env.OPA_URL),
    fidesUrl: emptyToUndefined(process.env.FIDES_URL),
    presidioUrl: emptyToUndefined(process.env.PRESIDIO_URL),
    keycloakIssuer: emptyToUndefined(process.env.KEYCLOAK_ISSUER),
    migrationsDir: process.env.MIGRATIONS_DIR ?? findMigrations(),
  };
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
