// © Infinitum Corporation®. All rights reserved.

import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { readEnv } from "../env.js";
import { createPgRuntime } from "../runtime.js";

const url = process.env.DATABASE_URL_TEST ?? "postgres://eidetic:eidetic@127.0.0.1:5432/eidetic_test";

async function canConnect(): Promise<boolean> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1000 });
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const live = await canConnect();

describe.skipIf(!live)("postgres pipeline", () => {
  const pool = new Pool({ connectionString: url });

  afterAll(async () => {
    await pool.end();
  });

  it("migrates, records a consented match, and rejects audit updates", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("GRANT ALL ON SCHEMA public TO eidetic");
    await pool.query("GRANT ALL ON SCHEMA public TO public");
    const env = readEnv();
    env.databaseUrl = url;
    env.demoMode = true;
    env.migrationsDir = path.resolve(process.cwd(), "apps/api/migrations");
    env.biometricStorePath = path.join(os.tmpdir(), "eidetic-it-templates");
    const runtime = await createPgRuntime(env, pool);
    const admin = await runtime.repos.actors.get("actor-admin");
    const operator = await runtime.repos.actors.get("actor-operator");
    const reviewer = await runtime.repos.actors.get("actor-reviewer");
    if (!admin || !operator || !reviewer) throw new Error("actors missing");
    await runtime.service.enroll({
      actor: admin,
      cid: "cid://infinitum/fixture-avery-quinn",
      displayName: "Avery Quinn",
      image: syntheticFixture("avery-quinn"),
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
    });
    const search = await runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    });
    expect(search.finalDecision).toBeNull();
    const recent = await runtime.repos.searches.countSince(operator.id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    expect(recent).toEqual({ counted: 1, rateLimited: 0 });
    await runtime.service.decide({
      actor: reviewer,
      reviewId: search.reviewId,
      decision: "confirm",
      selectedCid: "cid://infinitum/fixture-avery-quinn",
      notes: "Postgres round trip confirmed by a person.",
    });
    expect((await runtime.service.verifyAudit()).ok).toBe(true);
    const all = await runtime.service.listAudit();
    const newest = await runtime.service.pageAudit({ limit: 1 });
    expect(newest.entries.map((entry) => entry.seq)).toEqual([all.at(-1)?.seq]);
    expect(newest.nextBefore).toBe(all.at(-1)?.seq);
    const older = await runtime.service.pageAudit({ limit: 500, beforeSeq: newest.nextBefore ?? undefined });
    expect(older.entries).toHaveLength(all.length - 1);
    expect(older.nextBefore).toBeNull();
    const reviews = await runtime.service.pageAudit({ action: "review" });
    expect(reviews.entries.length).toBeGreaterThan(0);
    expect(reviews.entries.every((entry) => entry.action === "review")).toBe(true);
    await expect(pool.query("UPDATE audit_entries SET actor_id = 'tampered'")).rejects.toThrow(/append-only/);

    // Consent expiry round trip: stored, read back, and honoured by the eligibility query.
    const jordan = "cid://infinitum/fixture-jordan-blake";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await runtime.service.enroll({
      actor: admin,
      cid: jordan,
      displayName: "Jordan Blake",
      image: syntheticFixture("jordan-blake"),
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"], expiresAt }],
    });
    const [stored] = await runtime.repos.consents.listForSubject(jordan);
    expect(stored.expiresAt).toBe(expiresAt);
    const eligibleNow = await runtime.repos.consents.listEligible("record_reconciliation", "workforce_records", "consent", new Date().toISOString());
    expect(eligibleNow.map((subject) => subject.cid)).toContain(jordan);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const eligibleLater = await runtime.repos.consents.listEligible("record_reconciliation", "workforce_records", "consent", later);
    expect(eligibleLater.map((subject) => subject.cid)).not.toContain(jordan);
    await expect(pool.query("UPDATE consents SET expires_at = granted_at WHERE cid = $1", [jordan])).rejects.toThrow(
      /consents_expiry_after_grant/,
    );
  });
});
