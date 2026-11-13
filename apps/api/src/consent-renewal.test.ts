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
    accessLog: () => undefined,
  });
}

const json = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /v1/subjects/:cid/consents/:purposeCode/renew", () => {
  it("renews for an admin and validates the body", async () => {
    const app = await testApp();
    const cid = "cid://infinitum/fixture-avery-quinn";
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const enrolled = await app.request(
      "/v1/subjects",
      json("dev-admin", {
        displayName: "Avery Quinn",
        cid,
        legalBasis: "consent",
        fixtureId: "avery-quinn",
        purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"], expiresAt: soon }],
      }),
    );
    expect(enrolled.status).toBeLessThan(300);
    const path = `/v1/subjects/${encodeURIComponent(cid)}/consents/record_reconciliation/renew`;
    const later = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();

    expect((await app.request(path, json("dev-admin", { expiresAt: "next year" }))).status).toBe(422);
    expect((await app.request(path, json("dev-operator", { expiresAt: later }))).status).toBe(403);
    const renewed = await app.request(path, json("dev-admin", { expiresAt: later }));
    expect(renewed.status).toBe(200);
    const { subject } = (await renewed.json()) as { subject: { consents: Array<{ expiresAt: string | null }> } };
    expect(subject.consents.map((consent) => consent.expiresAt)).toContain(later);
  });
});
