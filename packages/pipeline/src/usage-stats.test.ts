// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

async function desk() {
  let clock = new Date("2026-11-07T12:00:00.000Z");
  const runtime = createMemoryRuntime({ now: () => clock });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const [admin, operator, reviewer, auditor] = await Promise.all(DEMO_ACTORS.map((actor) => runtime.repos.actors.get(actor.id)));
  if (!admin || !operator || !reviewer || !auditor) throw new Error("demo actors missing");
  await runtime.service.enroll({
    actor: admin,
    cid: "cid://infinitum/fixture-avery-quinn",
    displayName: "Avery Quinn",
    image: syntheticFixture("avery-quinn"),
    legalBasis: "consent",
    purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
  });
  const search = (purposeCode = "record_reconciliation") =>
    runtime.service.search({
      actor: operator,
      purposeCode,
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    });
  return { ...runtime, admin, operator, reviewer, auditor, search, advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}

describe("usage stats", () => {
  it("counts searches run and refused, refusal codes, decisions and the open queue", async () => {
    const { service, search, reviewer, auditor, advance } = await desk();
    const first = await search();
    await search();
    await expect(search("open_web_lookup")).rejects.toMatchObject({ code: "PURPOSE_UNKNOWN" });
    await service.decide({ actor: reviewer, reviewId: first.reviewId, decision: "reject", notes: "Not the same person, checked by eye." });

    const stats = await service.usageStats(auditor);
    expect(stats.hours).toBe(24);
    expect(stats.searches).toEqual({ total: 3, ran: 2, refused: 1 });
    expect(stats.byPurpose).toEqual([
      { purposeCode: "record_reconciliation", ran: 2, refused: 0 },
      { purposeCode: "open_web_lookup", ran: 0, refused: 1 },
    ]);
    expect(stats.refusalsByCode).toEqual([{ code: "PURPOSE_UNKNOWN", count: 1 }]);
    expect(stats.decisions).toEqual({ confirm: 0, reject: 1, inconclusive: 0, refused: 0 });
    expect(stats.pendingReviews).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("cid://");

    advance(25 * 60 * 60 * 1000);
    expect((await service.usageStats(auditor)).searches.total).toBe(0);
    expect((await service.usageStats(auditor, 48)).searches.total).toBe(3);
  });

  it("is for admins and auditors only", async () => {
    const { service, operator, reviewer, admin } = await desk();
    await expect(service.usageStats(operator)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.usageStats(reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await service.usageStats(admin)).searches.total).toBe(0);
  });
});
