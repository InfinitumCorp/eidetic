// © Infinitum Corporation®. All rights reserved.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { LocalTrillianCheckpointPort } from "@eidetic/audit";
import { HttpFidesConsentPort, LocalFidesConsentPort } from "@eidetic/consent";
import { LocalPatternRedactor, sha256Hex, type Actor } from "@eidetic/contracts";
import { verifyKeycloakAccessToken } from "@eidetic/policy";
import { FilesystemBiometricStore, createMatcher } from "@eidetic/matcher";
import {
  EideticService,
  createIdFactory,
  seedReferenceData,
  type Repositories,
} from "@eidetic/pipeline";
import { EmbeddedPolicyDecider, OpaPolicyDecider } from "@eidetic/policy";
import type { Env } from "./env.js";
import { migrate } from "./pg/migrate.js";
import { asSql, createPool } from "./pg/pool.js";
import { createRepositories, withTransaction } from "./pg/stores.js";
import { resolveAuditSigner } from "./startup.js";
import { cidActorSeeds, createCidVerifier, type CidProfile } from "./cid.js";

/** An actor, a verified Cumulus ID with no ei·det·ic™ role, or nobody. */
export type AuthResult = Actor | { noRole: CidProfile } | null;

export interface RunningApi {
  pool: Pool;
  repos: Repositories;
  service: EideticService;
  authenticate: (header: string | undefined) => Promise<AuthResult>;
}

export async function createPgRuntime(env: Env, pool = createPool(env.databaseUrl)): Promise<RunningApi> {
  await migrate(pool, env.migrationsDir);
  const signer = resolveAuditSigner(env);
  const repos = createRepositories(asSql(pool), signer);
  const cidSeeds = cidActorSeeds(env.cid);
  await seedReferenceData(repos, { demoMode: env.demoMode, actors: cidSeeds });
  const verifyCid = createCidVerifier(env.cid);
  const knownActors = new Set<string>();
  const service = new EideticService({
    repos,
    transaction: (fn) => withTransaction(pool, fn, signer),
    matcher: createMatcher({
      mode: env.matcherMode,
      captureProvider: env.captureProvider,
      store: new FilesystemBiometricStore(env.biometricStorePath),
      licenseAccepted: env.insightfaceLicenseAccepted,
      insightfaceUrl: env.insightfaceUrl,
      opencvMediapipeUrl: env.opencvMediapipeUrl,
      opencvMediapipeModelPath: env.opencvMediapipeModelPath,
      opencvMediapipePython: env.opencvMediapipePython,
      opencvZooModelDir: env.opencvZooModelDir,
      allowOperatorCaptures: env.allowOperatorCaptures,
    }),
    policy: env.opaUrl ? new OpaPolicyDecider(env.opaUrl) : new EmbeddedPolicyDecider(),
    redactor: new LocalPatternRedactor(),
    fides: env.fidesUrl ? new HttpFidesConsentPort(env.fidesUrl) : new LocalFidesConsentPort(),
    trillian: new LocalTrillianCheckpointPort(),
    milEnabled: env.milEnabled,
    now: () => new Date(),
    ids: createIdFactory(),
    searchLimitPerHour: env.searchLimitPerHour,
  });
  return {
    pool,
    repos,
    service,
    authenticate: async (header) => {
      if (!header?.startsWith("Bearer ")) return null;
      const token = header.slice("Bearer ".length).trim();
      if (!token) return null;
      // Local development only (EIDETIC_DEV_BEARER=true with DEMO_MODE=true): seeded dev-* tokens.
      if (env.devBearer && env.demoMode) {
        const dev = await repos.actors.findByTokenHash(sha256Hex(token));
        if (dev) return dev;
      }
      // People: Cumulus ID, checked at the issuer, role from CID_ADMINS / CID_REVIEWERS / ...
      const cid = await verifyCid(token);
      if (cid && "actor" in cid) {
        if (!knownActors.has(cid.actor.id)) {
          if (!(await repos.actors.get(cid.actor.id))) {
            await repos.actors.insert({ ...cid.actor, tokenHash: sha256Hex(`unusable-${randomUUID()}`) });
          }
          knownActors.add(cid.actor.id);
        }
        return cid.actor;
      }
      if (cid) return cid;
      // Machines: an optional Keycloak client-credentials token, when a realm is configured.
      if (env.keycloakIssuer && env.keycloakAudience) {
        const verified = await verifyKeycloakAccessToken(token, {
          issuer: env.keycloakIssuer,
          audience: env.keycloakAudience,
          jwks: env.keycloakJwksUrl ?? `${env.keycloakIssuer}/protocol/openid-connect/certs`,
        });
        if (verified) return { id: verified.subject, displayName: verified.subject, role: verified.role };
      }
      return null;
    },
  };
}

export async function waitForDatabase(pool: Pool): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last instanceof Error ? last : new Error("PostgreSQL did not become ready");
}
