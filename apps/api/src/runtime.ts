// © Infinitum Corporation®. All rights reserved.

import type { Pool } from "pg";
import { LocalTrillianCheckpointPort } from "@eidetic/audit";
import { HttpFidesConsentPort, LocalFidesConsentPort } from "@eidetic/consent";
import { LocalPatternRedactor, sha256Hex, type Actor } from "@eidetic/contracts";
import { FilesystemBiometricStore, createMatcher } from "@eidetic/matcher";
import {
  EideticService,
  createIdFactory,
  seedReferenceData,
  type Repositories,
} from "@eidetic/pipeline";
import { LocalPolicyDecider, OpaPolicyDecider } from "@eidetic/policy";
import type { Env } from "./env.js";
import { migrate } from "./pg/migrate.js";
import { asSql, createPool } from "./pg/pool.js";
import { createRepositories, withTransaction } from "./pg/stores.js";

export interface RunningApi {
  pool: Pool;
  repos: Repositories;
  service: EideticService;
  authenticate: (header: string | undefined) => Promise<Actor | null>;
}

export async function createPgRuntime(env: Env, pool = createPool(env.databaseUrl)): Promise<RunningApi> {
  await migrate(pool, env.migrationsDir);
  const repos = createRepositories(asSql(pool));
  await seedReferenceData(repos, { demoMode: env.demoMode });
  const service = new EideticService({
    repos,
    transaction: (fn) => withTransaction(pool, fn),
    matcher: createMatcher({
      mode: env.matcherMode,
      store: new FilesystemBiometricStore(env.biometricStorePath),
      licenseAccepted: env.insightfaceLicenseAccepted,
    }),
    policy: env.opaUrl ? new OpaPolicyDecider(env.opaUrl) : new LocalPolicyDecider(),
    redactor: new LocalPatternRedactor(),
    fides: env.fidesUrl ? new HttpFidesConsentPort(env.fidesUrl) : new LocalFidesConsentPort(),
    trillian: new LocalTrillianCheckpointPort(),
    milEnabled: env.milEnabled,
    now: () => new Date(),
    ids: createIdFactory(),
  });
  return {
    pool,
    repos,
    service,
    authenticate: async (header) => {
      if (env.keycloakIssuer && !env.demoMode) return null;
      if (!header?.startsWith("Bearer ")) return null;
      const token = header.slice("Bearer ".length).trim();
      if (!token) return null;
      return repos.actors.findByTokenHash(sha256Hex(token));
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
