// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";

async function testApp() {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const app = createApp({
    service: runtime.service,
    repos: runtime.repos,
    authenticate: async (header) => {
      if (!header?.startsWith("Bearer ")) return null;
      return runtime.repos.actors.findByTokenHash(sha256Hex(header.slice("Bearer ".length).trim()));
    },
    demoMode: true,
    matcherMode: "mock",
    milEnabled: false,
    dbPing: async () => true,
    adapters: { policy: "local" },
  });
  return app;
}

describe("HTTP pipeline", () => {
  it("requires a token, then enrolls, matches, reviews, and denies a purposeless search", async () => {
    const app = await testApp();
    const health = await app.request("/v1/health");
    expect(health.status).toBe(200);
    const anonymous = await app.request("/v1/searches", { method: "POST", body: "{}" });
    expect(anonymous.status).toBe(401);

    const admin = { authorization: "Bearer dev-admin", "content-type": "application/json" };
    const enrolled = await app.request("/v1/subjects", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        displayName: "Avery Quinn",
        cid: "cid://infinitum/fixture-avery-quinn",
        legalBasis: "consent",
        purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
        fixtureId: "avery-quinn",
        recordAttributes: { employeeId: "WQ-1044" },
      }),
    });
    expect(enrolled.status).toBe(201);

    const denied = await app.request("/v1/searches", {
      method: "POST",
      headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
      body: JSON.stringify({
        purposeCode: "open_web_lookup",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
      }),
    });
    expect(denied.status).toBe(403);
    const denial = await denied.json();
    expect(denial.error).toMatchObject({ code: "PURPOSE_UNKNOWN", matchRan: false });

    const search = await app.request("/v1/searches", {
      method: "POST",
      headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
      body: JSON.stringify({
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
      }),
    });
    expect(search.status).toBe(201);
    const body = await search.json();
    expect(body.finalDecision).toBeNull();
    expect(body.candidates[0].confidence).toBe(0.97);
    expect(body.geoRouting).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/embedding|templateRef|storeKey/);
    const settings = await app.request("/v1/settings/geo-routing", { headers: { authorization: "Bearer dev-admin" } });
    expect(await settings.json()).toEqual({ geoRouting: false, processOptIn: false, active: false, identityMatch: false });
    const unchanged = await app.request("/v1/edition", { headers: { authorization: "Bearer dev-admin" } });
    expect((await unchanged.json()).adapters).toEqual({ policy: "local" });

    const decision = await app.request(`/v1/reviews/${body.reviewId}/decide`, {
      method: "POST",
      headers: { authorization: "Bearer dev-reviewer", "content-type": "application/json" },
      body: JSON.stringify({
        decision: "confirm",
        selectedCid: "cid://infinitum/fixture-avery-quinn",
        notes: "The consented record and the sealed similarity agree.",
      }),
    });
    expect(decision.status).toBe(200);
    const decided = await decision.json();
    expect(decided.finalDecision).toBe("confirm");

    const proof = await app.request("/v1/audit/verify", { headers: { authorization: "Bearer dev-auditor" } });
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({ ok: true });
  });

  it("limits reads to the roles that need them", async () => {
    const app = await testApp();
    const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
    const seed = await app.request("/v1/demo/seed", {
      method: "POST",
      headers: { authorization: "Bearer dev-admin", "content-type": "application/json" },
      body: "{}",
    });
    expect(seed.status).toBe(201);
    const { reviewId } = (await seed.json()) as { reviewId: string };

    for (const path of ["/v1/subjects", "/v1/audit"]) {
      expect((await app.request(path, as("dev-admin"))).status).toBe(200);
      expect((await app.request(path, as("dev-auditor"))).status).toBe(200);
      const operator = await app.request(path, as("dev-operator"));
      expect(operator.status).toBe(403);
      expect((await operator.json()).error).toMatchObject({ code: "FORBIDDEN", matchRan: false });
      expect((await app.request(path, as("dev-reviewer"))).status).toBe(403);
    }
    expect((await app.request("/v1/bias/evaluations/r1", as("dev-reviewer"))).status).toBe(403);

    // The seeded search was run by the demo operator, so they see it; the reviewer sees the whole queue.
    const reviewerQueue = (await (await app.request("/v1/reviews", as("dev-reviewer"))).json()) as { reviews: unknown[] };
    expect(reviewerQueue.reviews.length).toBeGreaterThan(0);
    const operatorQueue = (await (await app.request("/v1/reviews", as("dev-operator"))).json()) as {
      reviews: { searchedBy: { id: string } }[];
    };
    expect(operatorQueue.reviews.every((review) => review.searchedBy.id === "actor-operator")).toBe(true);
    expect((await app.request(`/v1/reviews/${reviewId}`, as("dev-operator"))).status).toBe(200);
    // An admin who ran no searches through the operator role still reads it as an admin.
    expect((await app.request(`/v1/reviews/${reviewId}`, as("dev-admin"))).status).toBe(200);
  });
});
