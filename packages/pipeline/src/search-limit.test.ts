// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

async function desk(searchLimitPerHour: number | undefined) {
  let clock = new Date("2026-11-07T12:00:00.000Z");
  const runtime = createMemoryRuntime({ now: () => clock, searchLimitPerHour });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
  const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
  if (!admin || !operator) throw new Error("demo actors missing");
  await runtime.service.enroll({
    actor: admin,
    cid: "cid://infinitum/fixture-avery-quinn",
    displayName: "Avery Quinn",
    image: syntheticFixture("avery-quinn"),
    legalBasis: "consent",
    purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
  });
  const search = (actor = operator, purposeCode = "record_reconciliation") =>
    runtime.service.search({
      actor,
      purposeCode,
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    });
  return { ...runtime, admin, operator, search, advance: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}

const searchesOf = async (service: Awaited<ReturnType<typeof desk>>["service"]) =>
  (await service.listAudit()).filter((entry) => entry.action === "search");

describe("per-actor search limit", () => {
  it("refuses past the limit, audits only the first refusal, and frees up after an hour", async () => {
    const { service, search, advance } = await desk(3);
    await search();
    await search();
    // A policy refusal still counts: it is a search the account asked for.
    await expect(search(undefined, "open_web_lookup")).rejects.toMatchObject({ code: "PURPOSE_UNKNOWN" });
    const before = (await searchesOf(service)).length;

    await expect(search()).rejects.toMatchObject({ code: "RATE_LIMITED", httpStatus: 429, matchRan: false });
    await expect(search()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(search()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const audited = await searchesOf(service);
    expect(audited.length).toBe(before + 1);
    expect(audited.at(-1)!.attestation).toMatchObject({ outcome: "denied", code: "RATE_LIMITED", matchRan: false });
    expect((await service.verifyAudit()).ok).toBe(true);

    advance(61 * 60 * 1000);
    expect((await search()).matchRan).toBe(true);
  });

  it("counts each actor separately", async () => {
    const { search, admin } = await desk(1);
    await search();
    await expect(search()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // The seeded admin is not on the purpose's role list, so it is refused by policy, not by the limit.
    await expect(search(admin)).rejects.not.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("is off when the limit is unset or 0", async () => {
    for (const limit of [undefined, 0]) {
      const { search } = await desk(limit);
      for (let i = 0; i < 5; i += 1) expect((await search()).matchRan).toBe(true);
    }
  });
});
