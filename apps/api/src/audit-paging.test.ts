// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";

interface Page {
  entries: { seq: number; action: string }[];
  nextBefore: number | null;
}

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
  return { app, runtime };
}

describe("audit paging", () => {
  it("pages the log newest first and walks back to the start", async () => {
    const { app, runtime } = await testApp();
    const admin = { authorization: "Bearer dev-admin", "content-type": "application/json" };
    for (let index = 0; index < 5; index += 1) {
      const response = await app.request("/v1/purposes", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          code: `paging_check_${index}`,
          title: `Paging check ${index}`,
          description: "A purpose published to fill the audit log for the paging test.",
          edition: "business",
          legalBases: ["consent"],
          datasetIds: ["workforce_records"],
          allowedRoles: ["operator"],
          active: true,
        }),
      });
      expect(response.status).toBe(201);
    }
    const total = (await runtime.service.listAudit()).length;
    expect(total).toBeGreaterThanOrEqual(5);

    const seen: number[] = [];
    let before: number | null = null;
    do {
      const query: string = before === null ? "?limit=2" : `?limit=2&before=${before}`;
      const response = await app.request(`/v1/audit${query}`, { headers: admin });
      expect(response.status).toBe(200);
      const page = (await response.json()) as Page;
      expect(page.entries.length).toBeLessThanOrEqual(2);
      seen.push(...page.entries.map((entry) => entry.seq));
      before = page.nextBefore;
    } while (before !== null);

    expect(seen).toHaveLength(total);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(seen.at(-1)).toBe(1);
  });

  it("filters by action and rejects bad paging input", async () => {
    const { app } = await testApp();
    const admin = { authorization: "Bearer dev-admin" };
    const filtered = (await (await app.request("/v1/audit?action=search", { headers: admin })).json()) as Page;
    expect(filtered.entries.every((entry) => entry.action === "search")).toBe(true);
    expect((await app.request("/v1/audit?limit=0", { headers: admin })).status).toBe(422);
    expect((await app.request("/v1/audit?limit=501", { headers: admin })).status).toBe(422);
    expect((await app.request("/v1/audit?before=abc", { headers: admin })).status).toBe(422);
    expect((await app.request("/v1/audit?action=DROP%20TABLE", { headers: admin })).status).toBe(422);
  });
});
