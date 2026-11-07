// © Infinitum Corporation®. All rights reserved.

import type { Actor } from "@eidetic/contracts";
import { syntheticFixture } from "@eidetic/matcher";
import type { EideticService } from "./service.js";

export const SYNTHETIC_SUBJECTS = [
  {
    cid: "cid://infinitum/fixture-avery-quinn",
    displayName: "Avery Quinn",
    fixtureId: "avery-quinn",
    employeeId: "WQ-1044",
  },
  {
    cid: "cid://infinitum/fixture-jordan-blake",
    displayName: "Jordan Blake",
    fixtureId: "jordan-blake",
    employeeId: "WQ-2281",
  },
] as const;

/** Re-enrolls two synthetic people and leaves one unconfirmed review on the desk. */
export async function seedSyntheticQueue(
  service: EideticService,
  actors: { admin: Actor; operator: Actor },
): Promise<{ subjects: string[]; searchId: string; reviewId: string }> {
  for (const subject of SYNTHETIC_SUBJECTS) {
    await service.enroll({
      actor: actors.admin,
      cid: subject.cid,
      displayName: subject.displayName,
      image: syntheticFixture(subject.fixtureId),
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
      recordAttributes: { employeeId: subject.employeeId, site: "Washington" },
    });
  }
  const search = await service.search({
    actor: actors.operator,
    purposeCode: "record_reconciliation",
    legalBasis: "consent",
    datasetId: "workforce_records",
    edition: "business",
    image: syntheticFixture("avery-quinn"),
  });
  return {
    subjects: SYNTHETIC_SUBJECTS.map((subject) => subject.cid),
    searchId: search.searchId,
    reviewId: search.reviewId,
  };
}
