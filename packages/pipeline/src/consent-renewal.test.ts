// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

const AVERY = "cid://infinitum/fixture-avery-quinn";
const PURPOSE = "record_reconciliation";

/** A desk whose clock the test moves forward. */
async function desk() {
  let clock = new Date("2026-11-07T12:00:00.000Z");
  const runtime = createMemoryRuntime({ now: () => clock });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
  const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
  if (!admin || !operator) throw new Error("demo actors missing");
  const search = () =>
    runtime.service.search({
      actor: operator,
      purposeCode: PURPOSE,
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    });
  const enroll = (expiresAt?: string) =>
    runtime.service.enroll({
      actor: admin,
      cid: AVERY,
      displayName: "Avery Quinn",
      image: syntheticFixture("avery-quinn"),
      legalBasis: "consent",
      purposes: [{ purposeCode: PURPOSE, datasetIds: ["workforce_records"], expiresAt }],
    });
  return { ...runtime, admin, operator, search, enroll, advanceTo: (iso: string) => void (clock = new Date(iso)) };
}

const cids = (result: { candidates: Array<{ cid: string }> }) => result.candidates.map((candidate) => candidate.cid);

describe("consent renewal", () => {
  it("keeps a person searchable past the old expiry with a new receipt and an audit entry", async () => {
    const { service, admin, search, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    const view = await service.renewConsent(admin, AVERY, PURPOSE, "2027-12-01T00:00:00.000Z");

    const grants = view.consents.filter((consent) => consent.purposeCode === PURPOSE);
    expect(grants.map((grant) => grant.expiresAt)).toEqual(["2026-12-01T00:00:00.000Z", "2027-12-01T00:00:00.000Z"]);
    expect(new Set(grants.map((grant) => grant.receiptHash)).size).toBe(2);
    expect(grants[1].datasetIds).toEqual(["workforce_records"]);

    advanceTo("2027-01-15T00:00:00.000Z");
    expect(cids(await search())).toContain(AVERY);
    advanceTo("2027-12-02T00:00:00.000Z");
    // The renewal lapses too; with no live consent left the gallery is empty.
    await expect(search()).rejects.toMatchObject({ code: "CONSENT_REQUIRED", matchRan: false });

    const renewal = (await service.listAudit()).find((entry) => entry.action === "consent_renewed");
    expect(renewal?.attestation).toMatchObject({ outcome: "recorded", matchRan: false, subjectCid: AVERY, purposeCode: PURPOSE, receiptHash: grants[1].receiptHash });
    expect((await service.verifyAudit()).ok).toBe(true);
  });

  it("can renew a grant that already lapsed, while the template is still sealed", async () => {
    const { service, admin, search, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    advanceTo("2026-12-05T00:00:00.000Z");
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2026-12-04T00:00:00.000Z")).rejects.toMatchObject({ code: "VALIDATION" });
    await service.renewConsent(admin, AVERY, PURPOSE, "2027-06-01T00:00:00.000Z");
    expect(cids(await search())).toContain(AVERY);
  });

  it("refuses what is not a renewal", async () => {
    const { service, admin, operator, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    await expect(service.renewConsent(operator, AVERY, PURPOSE, "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Shortening or keeping the expiry is not a renewal.
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2026-11-20T00:00:00.000Z")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2026-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(service.renewConsent(admin, AVERY, "open_web_lookup", "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.renewConsent(admin, "cid://infinitum/nobody-here", PURPOSE, null)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // After a full withdrawal, consent has to be recorded again by enrollment.
    await service.withdraw(admin, AVERY);
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: "CONSENT_WITHDRAWN" });

    // Nothing to renew on consent that never expires.
    advanceTo("2026-11-08T00:00:00.000Z");
    await enroll();
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses once the template was purged for lapsed consent", async () => {
    const { service, admin, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    advanceTo("2026-12-02T00:00:00.000Z");
    await service.sweepLapsedConsent(admin);
    await expect(service.renewConsent(admin, AVERY, PURPOSE, "2027-12-01T00:00:00.000Z")).rejects.toMatchObject({ code: expect.stringMatching(/TEMPLATE_MISSING|CONSENT_WITHDRAWN/) });
  });

  it("renews without an expiry when asked", async () => {
    const { service, admin, search, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    await service.renewConsent(admin, AVERY, PURPOSE, null);
    advanceTo("2030-01-01T00:00:00.000Z");
    expect(cids(await search())).toContain(AVERY);
  });
});
