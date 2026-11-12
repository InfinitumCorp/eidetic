// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { seedReferenceData } from "./seed.js";

async function desk() {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const actor = async (id: string) => {
    const found = await runtime.repos.actors.get(id);
    if (!found) throw new Error(`missing ${id}`);
    return found;
  };
  return { service: runtime.service, admin: await actor("actor-admin"), operator: await actor("actor-operator") };
}

describe("editing a published purpose", () => {
  it("does not widen consent that was already given", async () => {
    const { service, admin, operator } = await desk();
    const purpose = {
      code: "visitor_check_in",
      title: "Visitor check-in",
      description: "Recognize a visitor who enrolled for check-in at reception.",
      edition: "business" as const,
      legalBases: ["consent" as const],
      datasetIds: ["visitor_log"],
      allowedRoles: ["operator" as const],
      active: true,
    };
    await service.createPurpose(admin, purpose);
    await service.enroll({
      actor: admin,
      cid: "cid://infinitum/fixture-avery-quinn",
      displayName: "Avery Quinn",
      image: syntheticFixture("avery-quinn"),
      legalBasis: "consent",
      purposes: [{ purposeCode: "visitor_check_in", datasetIds: ["visitor_log"] }],
    });

    // The admin edits the purpose: a clearer title and a second dataset.
    await service.createPurpose(admin, { ...purpose, title: "Visitor check-in at reception", datasetIds: ["visitor_log", "badge_photos"] });
    const edited = (await service.listPurposes()).find((item) => item.code === "visitor_check_in");
    expect(edited).toMatchObject({ title: "Visitor check-in at reception", datasetIds: ["visitor_log", "badge_photos"], active: true });

    const search = (datasetId: string) =>
      service.search({
        actor: operator,
        purposeCode: "visitor_check_in",
        legalBasis: "consent",
        datasetId,
        edition: "business",
        image: syntheticFixture("avery-quinn"),
      });

    // Avery consented to visitor_log only. The new dataset finds no one.
    await expect(search("badge_photos")).rejects.toMatchObject({ matchRan: false });
    const allowed = await search("visitor_log");
    expect(allowed.candidates.map((candidate) => candidate.cid)).toContain("cid://infinitum/fixture-avery-quinn");
  });
});
