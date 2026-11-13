// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";

async function testApp() {
  const runtime = createMemoryRuntime();
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
  });
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe("GET /v1/stats/usage", () => {
  it("answers admins and auditors, refuses other roles, and validates the window", async () => {
    const app = await testApp();
    const ok = await app.request("/v1/stats/usage?hours=168", as("dev-auditor"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ hours: 168, searches: { total: 0 } });
    expect((await app.request("/v1/stats/usage", as("dev-operator"))).status).toBe(403);
    expect((await app.request("/v1/stats/usage?hours=0", as("dev-admin"))).status).toBe(422);
    expect((await app.request("/v1/stats/usage?hours=99999", as("dev-admin"))).status).toBe(422);
  });
});
