// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { seedSyntheticQueue, SYNTHETIC_SUBJECTS } from "./demo.js";
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
  const admin = await actor("actor-admin");
  const operator = await actor("actor-operator");
  const reviewer = await actor("actor-reviewer");
  const seeded = await seedSyntheticQueue(runtime.service, { admin, operator });
  const review = await runtime.service.getReview(seeded.reviewId);
  const purpose = (await runtime.service.listPurposes()).find((item) => item.code === review.purposeCode);
  if (!purpose) throw new Error("purpose missing");
  return { service: runtime.service, admin, reviewer, reviewId: seeded.reviewId, purpose };
}

describe("a purpose retired after the search", () => {
  it("refuses a confirmation and audits the refusal", async () => {
    const { service, admin, reviewer, reviewId, purpose } = await desk();
    await service.createPurpose(admin, { ...purpose, active: false });
    const before = (await service.listAudit()).length;

    await expect(
      service.decide({
        actor: reviewer,
        reviewId,
        decision: "confirm",
        selectedCid: SYNTHETIC_SUBJECTS[0].cid,
        notes: "Confirming after the purpose was retired.",
      }),
    ).rejects.toMatchObject({ code: "PURPOSE_INACTIVE", matchRan: false });

    const audit = await service.listAudit();
    expect(audit).toHaveLength(before + 1);
    expect(audit.at(-1)?.attestation).toMatchObject({ outcome: "denied", code: "PURPOSE_INACTIVE", reviewId });
    expect((await service.getReview(reviewId)).status).toBe("pending");
    expect((await service.verifyAudit()).ok).toBe(true);
  });

  it("still lets the reviewer reject, so the review can close", async () => {
    const { service, admin, reviewer, reviewId, purpose } = await desk();
    await service.createPurpose(admin, { ...purpose, active: false });
    const decided = await service.decide({
      actor: reviewer,
      reviewId,
      decision: "reject",
      notes: "Purpose retired; closing without naming anyone.",
    });
    expect(decided.finalDecision).toBe("reject");
  });

  it("confirms again once the purpose is reinstated", async () => {
    const { service, admin, reviewer, reviewId, purpose } = await desk();
    await service.createPurpose(admin, { ...purpose, active: false });
    await service.createPurpose(admin, { ...purpose, active: true });
    const decided = await service.decide({
      actor: reviewer,
      reviewId,
      decision: "confirm",
      selectedCid: SYNTHETIC_SUBJECTS[0].cid,
      notes: "Purpose reinstated; the match stands.",
    });
    expect(decided.finalDecision).toBe("confirm");
  });
});
