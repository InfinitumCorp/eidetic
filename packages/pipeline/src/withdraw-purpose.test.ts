// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { seedReferenceData } from "./seed.js";

const AVERY = "cid://infinitum/fixture-avery-quinn";

async function desk() {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const actor = async (id: string) => {
    const found = await runtime.repos.actors.get(id);
    if (!found) throw new Error(`missing ${id}`);
    return found;
  };
  const admin = await actor("actor-admin");
  const operator = await actor("actor-operator");
  await runtime.service.enroll({
    actor: admin,
    cid: AVERY,
    displayName: "Avery Quinn",
    image: syntheticFixture("avery-quinn"),
    legalBasis: "consent",
    purposes: [
      { purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] },
      { purposeCode: "access_control", datasetIds: ["facility_access"] },
    ],
  });
  const search = (purposeCode: string, datasetId: string) =>
    runtime.service.search({
      actor: operator,
      purposeCode,
      legalBasis: "consent",
      datasetId,
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    });
  return { service: runtime.service, admin, operator, search };
}

describe("withdrawing consent for one purpose", () => {
  it("stops that purpose and keeps the others and the template", async () => {
    const { service, admin, search } = await desk();
    const view = await service.withdrawPurpose(admin, AVERY, "access_control");

    expect(view.status).toBe("active");
    expect(view.template.present).toBe(true);
    expect(view.consents.find((consent) => consent.purposeCode === "access_control")?.status).toBe("withdrawn");
    expect(view.consents.find((consent) => consent.purposeCode === "record_reconciliation")?.status).toBe("granted");

    await expect(search("access_control", "facility_access")).rejects.toMatchObject({ matchRan: false });
    const still = await search("record_reconciliation", "workforce_records");
    expect(still.candidates.map((candidate) => candidate.cid)).toContain(AVERY);

    const entry = (await service.listAudit()).filter((item) => item.action === "withdraw").at(-1);
    expect(entry?.attestation).toMatchObject({ subjectCid: AVERY, purposeCode: "access_control" });
    expect(entry?.attestation.sealedStorePurged).toBeUndefined();
    expect((await service.verifyAudit()).ok).toBe(true);
  });

  it("withdrawing the last purpose is a full withdrawal and purges the template", async () => {
    const { service, admin, search } = await desk();
    await service.withdrawPurpose(admin, AVERY, "access_control");
    const view = await service.withdrawPurpose(admin, AVERY, "record_reconciliation");

    expect(view.status).toBe("withdrawn");
    expect(view.template.present).toBe(false);
    expect(view.consents.every((consent) => consent.status === "withdrawn")).toBe(true);
    await expect(search("record_reconciliation", "workforce_records")).rejects.toMatchObject({ matchRan: false });
    const entry = (await service.listAudit()).filter((item) => item.action === "withdraw").at(-1);
    expect(entry?.attestation).toMatchObject({ purposeCode: "record_reconciliation", sealedStorePurged: true });
  });

  it("refuses non-admins, unknown purposes, and repeats", async () => {
    const { service, admin, operator } = await desk();
    await expect(service.withdrawPurpose(operator, AVERY, "access_control")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.withdrawPurpose(admin, AVERY, "consented_assistance")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await service.withdrawPurpose(admin, AVERY, "access_control");
    await expect(service.withdrawPurpose(admin, AVERY, "access_control")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
