// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { consentIsLive } from "@eidetic/contracts";
import { buildConsentReceipt } from "@eidetic/consent";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

const AVERY = "cid://infinitum/fixture-avery-quinn";
const purposes = (expiresAt?: string) => [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"], expiresAt }];

/** A desk whose clock the test moves forward. */
async function desk() {
  let clock = new Date("2026-11-07T12:00:00.000Z");
  const runtime = createMemoryRuntime({ now: () => clock });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
  const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
  const reviewer = await runtime.repos.actors.get(DEMO_ACTORS[2].id);
  if (!admin || !operator || !reviewer) throw new Error("demo actors missing");
  const search = (subjectCid?: string) =>
    runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      subjectCid,
      image: syntheticFixture("avery-quinn"),
    });
  const enroll = (expiresAt?: string) =>
    runtime.service.enroll({
      actor: admin,
      cid: AVERY,
      displayName: "Avery Quinn",
      image: syntheticFixture("avery-quinn"),
      legalBasis: "consent",
      purposes: purposes(expiresAt),
    });
  return {
    ...runtime,
    admin,
    reviewer,
    search,
    enroll,
    advanceTo: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

describe("consent expiry", () => {
  it("matches until the expiry, then refuses gallery and named searches", async () => {
    const { service, search, enroll, advanceTo } = await desk();
    await enroll("2026-12-01T00:00:00.000Z");
    const before = await search();
    expect(before.candidates[0].cid).toBe(AVERY);

    advanceTo("2026-12-01T00:00:00.000Z");
    await expect(search()).rejects.toMatchObject({ code: "CONSENT_REQUIRED", matchRan: false });
    await expect(search(AVERY)).rejects.toMatchObject({ code: "CONSENT_EXPIRED", matchRan: false });

    const [subject] = await service.listSubjects();
    expect(subject.consents[0]).toMatchObject({ status: "granted", expiresAt: "2026-12-01T00:00:00.000Z", expired: true });
    expect((await service.verifyAudit()).ok).toBe(true);
  });

  it("refuses to confirm a match once the consent behind it has expired", async () => {
    const { service, search, enroll, advanceTo, reviewer } = await desk();
    await enroll("2026-11-08T00:00:00.000Z");
    const pending = await search();
    advanceTo("2026-11-09T00:00:00.000Z");
    await expect(
      service.decide({
        actor: reviewer,
        reviewId: pending.reviewId,
        decision: "confirm",
        selectedCid: AVERY,
        notes: "Confirming after the consent window closed.",
      }),
    ).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    const last = (await service.listAudit()).at(-1)!;
    expect(last.attestation).toMatchObject({ code: "CONSENT_EXPIRED", matchRan: false });
  });

  it("renews an expired grant on re-enrollment and rejects an expiry in the past", async () => {
    const { service, search, enroll, advanceTo } = await desk();
    await enroll("2026-11-08T00:00:00.000Z");
    advanceTo("2026-11-10T00:00:00.000Z");
    await expect(enroll("2026-11-09T00:00:00.000Z")).rejects.toMatchObject({ code: "VALIDATION" });
    const renewed = await enroll("2027-11-10T00:00:00.000Z");
    expect(renewed.receipts).toHaveLength(1);
    expect((await search()).candidates[0].cid).toBe(AVERY);
    const [subject] = await service.listSubjects();
    expect(subject.consents.map((consent) => consent.expired)).toEqual([true, false]);
  });

  it("keeps consent without an expiry live, and keeps old receipt hashes stable", () => {
    expect(consentIsLive({ status: "granted", expiresAt: null }, "2099-01-01T00:00:00.000Z")).toBe(true);
    expect(consentIsLive({ status: "withdrawn", expiresAt: null }, "2026-01-01T00:00:00.000Z")).toBe(false);
    const base = { cid: AVERY, purposeCode: "p", datasetIds: ["d"], legalBasis: "consent" as const, status: "granted" as const, at: "2026-11-07T12:00:00.000Z" };
    const plain = buildConsentReceipt(base);
    expect(buildConsentReceipt({ ...base, expiresAt: null }).proof.payloadHash).toBe(plain.proof.payloadHash);
    const dated = buildConsentReceipt({ ...base, expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(dated.credentialSubject.expiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(dated.proof.payloadHash).not.toBe(plain.proof.payloadHash);
  });
});
