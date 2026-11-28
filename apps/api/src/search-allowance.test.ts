// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";

async function testApp(searchLimitPerHour?: number) {
  const runtime = createMemoryRuntime({ searchLimitPerHour });
  await seedReferenceData(runtime.repos, { demoMode: true });
  return createApp({
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
    accessLog: () => undefined,
  });
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe("GET /v1/searches/allowance", () => {
  it("needs a signed-in actor", async () => {
    const app = await testApp(5);
    expect((await app.request("/v1/searches/allowance")).status).toBe(401);
  });

  it("counts the caller's own searches against the limit", async () => {
    const app = await testApp(5);
    const search = await app.request("/v1/searches", {
      method: "POST",
      headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
      body: JSON.stringify({ purposeCode: "record_reconciliation", legalBasis: "consent", datasetId: "workforce_records", fixtureId: "avery-quinn" }),
    });
    expect(search.status).toBeLessThan(500);
    const mine = await app.request("/v1/searches/allowance", as("dev-operator"));
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ limit: 5, used: 1, remaining: 4, windowMinutes: 60 });
    const theirs = await app.request("/v1/searches/allowance", as("dev-reviewer"));
    expect(await theirs.json()).toMatchObject({ used: 0, remaining: 5 });
  });

  it("says there is no limit when none is set", async () => {
    const app = await testApp();
    const body = await (await app.request("/v1/searches/allowance", as("dev-operator"))).json();
    expect(body).toMatchObject({ limit: null, remaining: null });
  });
});
