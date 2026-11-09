// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { EideticError } from "@eidetic/contracts";
import {
  MemoryBiometricStore,
  MockMatcher,
  syntheticFixture,
  type MatchRequest,
  type MatcherAdapter,
} from "@eidetic/matcher";
import { seedSyntheticQueue, SYNTHETIC_SUBJECTS } from "./demo.js";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

class SpyMatcher implements MatcherAdapter {
  matchCalls = 0;

  constructor(private readonly inner: MatcherAdapter) {}

  get model() {
    return this.inner.model;
  }

  assess(image: Uint8Array) {
    return this.inner.assess(image);
  }

  enroll(image: Uint8Array) {
    return this.inner.enroll(image);
  }

  match(request: MatchRequest) {
    this.matchCalls += 1;
    return this.inner.match(request);
  }

  purge(templateRef: string) {
    return this.inner.purge(templateRef);
  }
}

async function desk() {
  const spy = new SpyMatcher(new MockMatcher(new MemoryBiometricStore()));
  const runtime = createMemoryRuntime({ matcher: spy });
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
  const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
  const reviewer = await runtime.repos.actors.get(DEMO_ACTORS[2].id);
  if (!admin || !operator || !reviewer) throw new Error("demo actors missing");
  return { ...runtime, spy, admin, operator, reviewer };
}

describe("authorize, match, review, record", () => {
  it("walks the happy path and keeps the score unconfirmed until a reviewer decides", async () => {
    const { service, spy, admin, operator, reviewer } = await desk();
    const seeded = await seedSyntheticQueue(service, { admin, operator });
    const pending = await service.getReview(seeded.reviewId);
    expect(pending.finalDecision).toBeNull();
    expect(pending.status).toBe("pending");
    expect(pending.topConfidence).toBe(0.97);
    expect(pending.subjectName).toBe("Avery Quinn");
    expect(spy.matchCalls).toBe(1);

    await expect(
      service.decide({
        actor: operator,
        reviewId: seeded.reviewId,
        decision: "confirm",
        selectedCid: SYNTHETIC_SUBJECTS[0].cid,
        notes: "Operator trying to close their own search.",
      }),
    ).rejects.toBeInstanceOf(EideticError);

    const decided = await service.decide({
      actor: reviewer,
      reviewId: seeded.reviewId,
      decision: "confirm",
      selectedCid: SYNTHETIC_SUBJECTS[0].cid,
      notes: "Gallery agreement and the consented workforce record are enough.",
    });
    expect(decided.finalDecision).toBe("confirm");
    expect(decided.matchRan).toBe(false);
    const proof = await service.verifyAudit();
    expect(proof.ok).toBe(true);
    expect(proof.entries).toBeGreaterThan(2);
    const serialized = JSON.stringify(await service.listAudit());
    expect(serialized).not.toMatch(/embedding|templateRef|imageBase64/);
    expect(decided.audit.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed without a purpose, after withdrawal, and for MIL", async () => {
    const { service, spy, admin, operator } = await desk();
    await seedSyntheticQueue(service, { admin, operator });
    const callsAfterSeed = spy.matchCalls;

    await expect(
      service.search({
        actor: operator,
        purposeCode: "open_web_lookup",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        image: syntheticFixture("avery-quinn"),
      }),
    ).rejects.toMatchObject({ code: "PURPOSE_UNKNOWN", matchRan: false });

    await service.withdraw(admin, SYNTHETIC_SUBJECTS[1].cid);
    await expect(
      service.search({
        actor: operator,
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        image: syntheticFixture("jordan-blake"),
        subjectCid: SYNTHETIC_SUBJECTS[1].cid,
      }),
    ).rejects.toMatchObject({ code: "CONSENT_WITHDRAWN", matchRan: false });

    await expect(
      service.search({
        actor: operator,
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "mil",
        image: syntheticFixture("avery-quinn"),
      }),
    ).rejects.toMatchObject({ code: "MIL_NOT_ENABLED", matchRan: false });

    expect(spy.matchCalls).toBe(callsAfterSeed);
    expect((await service.verifyAudit()).ok).toBe(true);
  });

  it("stops a reviewer from confirming their own search and redacts phone numbers in the audit note", async () => {
    const { service, repos, admin, reviewer } = await desk();
    await service.createPurpose(admin, {
      code: "reviewer_drill",
      title: "Reviewer drill",
      description: "Temporary purpose so a reviewer can run a search in the test.",
      edition: "business",
      legalBases: ["consent"],
      datasetIds: ["workforce_records"],
      allowedRoles: ["reviewer"],
      active: true,
    });
    await service.enroll({
      actor: admin,
      displayName: "Casey Morgan",
      image: syntheticFixture("casey-morgan"),
      legalBasis: "consent",
      purposes: [{ purposeCode: "reviewer_drill", datasetIds: ["workforce_records"] }],
    });
    const search = await service.search({
      actor: reviewer,
      purposeCode: "reviewer_drill",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("casey-morgan"),
    });
    await expect(
      service.decide({
        actor: reviewer,
        reviewId: search.reviewId,
        decision: "reject",
        notes: "Call 202-555-0199 if this were allowed.",
      }),
    ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });
    const operator = await repos.actors.get("actor-operator");
    if (!operator) throw new Error("operator missing");
    await service.decide({
      actor: { ...operator, role: "reviewer" },
      reviewId: search.reviewId,
      decision: "reject",
      notes: "Reach the desk at 202-555-0199 only if needed.",
    });
    const audit = await service.listAudit();
    const note = audit.at(-1)?.attestation.notes ?? "";
    expect(note).toContain("[redacted-phone]");
    expect(note).not.toContain("202-555-0199");
  });

  it("keeps the match when a geo routing note is present and ignores a note that tries to change the decision", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const inner = new MockMatcher(new MemoryBiometricStore());
    const matcher: MatcherAdapter = {
      get model() {
        return inner.model;
      },
      assess: (image) => inner.assess(image),
      enroll: (image) => inner.enroll(image),
      purge: (templateRef) => inner.purge(templateRef),
      match: (request) => {
        seen.push(request.recordHints);
        return inner.match(request);
      },
    };
    const runtime = createMemoryRuntime({
      matcher,
      annotatePolicy: (decision, routing) => {
        if (routing?.ip === "deny-me") {
          return { allow: false, code: "FORBIDDEN", message: "Geo routing cannot deny a search.", geoRouting: { countryCode: "US", categories: ["google"], usedForIdentityMatch: false } };
        }
        if (!routing?.ip) return decision;
        return { ...decision, geoRouting: { countryCode: "US", categories: ["google"], usedForIdentityMatch: false } };
      },
    });
    await seedReferenceData(runtime.repos, { demoMode: true });
    const admin = await runtime.repos.actors.get(DEMO_ACTORS[0].id);
    const operator = await runtime.repos.actors.get(DEMO_ACTORS[1].id);
    if (!admin || !operator) throw new Error("demo actors missing");
    await seedSyntheticQueue(runtime.service, { admin, operator });
    const search = await runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
      recordHints: { site: "Washington" },
      routing: { ip: "1.2.3.4", domain: "www.google.com" },
    });
    expect(search.candidates[0]?.confidence).toBe(0.97);
    expect(search.geoRouting).toEqual({ countryCode: "US", categories: ["google"], usedForIdentityMatch: false });
    expect(seen.at(-1)).toEqual({ site: "Washington" });
    expect(JSON.stringify(await runtime.service.listAudit())).not.toContain("1.2.3.4");
    const deniedAttempt = await runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
      routing: { ip: "deny-me" },
    });
    expect(deniedAttempt.matchRan).toBe(true);
    expect(deniedAttempt.geoRouting).toBeUndefined();
  });
});
