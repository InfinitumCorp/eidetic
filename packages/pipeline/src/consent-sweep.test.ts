// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

const AVERY = "cid://infinitum/fixture-avery-quinn";
const JORDAN = "cid://infinitum/fixture-jordan-blake";

async function desk() {
  let clock = new Date("2026-11-07T12:00:00.000Z");
  const runtime = createMemoryRuntime({ now: () => clock });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
  const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
  if (!admin || !operator) throw new Error("demo actors missing");
  const enroll = (cid: string, fixture: string, expiresAt?: string) =>
    runtime.service.enroll({
      actor: admin,
      cid,
      displayName: fixture,
      image: syntheticFixture(fixture),
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"], expiresAt }],
    });
  return { ...runtime, admin, operator, enroll, advanceTo: (iso: string) => void (clock = new Date(iso)) };
}

describe("lapsed consent sweep", () => {
  it("purges only templates whose every grant has lapsed, audits each, and is idempotent", async () => {
    const { service, repos, admin, enroll, advanceTo } = await desk();
    await enroll(AVERY, "avery-quinn", "2026-11-08T00:00:00.000Z");
    await enroll(JORDAN, "jordan-blake");

    const early = await service.sweepLapsedConsent(admin);
    expect(early.purged).toEqual([]);

    advanceTo("2026-11-09T00:00:00.000Z");
    const swept = await service.sweepLapsedConsent(admin);
    expect(swept.purged.map((item) => item.cid)).toEqual([AVERY]);
    expect(await repos.templates.activeForCid(AVERY)).toBeNull();
    expect(await repos.templates.activeForCid(JORDAN)).not.toBeNull();

    const last = (await service.listAudit()).at(-1)!;
    expect(last).toMatchObject({ action: "consent_lapsed", seq: swept.purged[0].seq });
    expect(last.attestation).toMatchObject({ subjectCid: AVERY, sealedStorePurged: true, matchRan: false });
    expect((await service.verifyAudit()).ok).toBe(true);

    expect((await service.sweepLapsedConsent(admin)).purged).toEqual([]);
    // The record and consent history stay, so the person can come back with fresh consent.
    const [avery] = (await service.listSubjects()).filter((subject) => subject.cid === AVERY);
    expect(avery).toMatchObject({ status: "active", template: { present: false } });
    const renewed = await enroll(AVERY, "avery-quinn", "2027-11-09T00:00:00.000Z");
    expect(renewed.templateStored).toBe(true);
    expect(await repos.templates.activeForCid(AVERY)).not.toBeNull();
  });

  it("is admin only", async () => {
    const { service, operator } = await desk();
    await expect(service.sweepLapsedConsent(operator)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
