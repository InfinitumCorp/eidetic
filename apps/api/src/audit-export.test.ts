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

describe("GET /v1/audit/export", () => {
  it("downloads a signed export for auditors and refuses operators", async () => {
    const app = await testApp();
    expect((await app.request("/v1/audit/export", as("dev-operator"))).status).toBe(403);
    const res = await app.request("/v1/audit/export", as("dev-auditor"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="eidetic-audit-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { entries: Array<{ action: string }> };
    expect(body.entries.at(-1)?.action).toBe("audit_export");
  });
});
