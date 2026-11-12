// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";

const AVERY = "cid://infinitum/fixture-avery-quinn";
const JORDAN = "cid://infinitum/fixture-jordan-blake";

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

const json = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function enroll(app: Awaited<ReturnType<typeof testApp>>["app"], cid: string, name: string, fixtureId: string) {
  const res = await app.request("/v1/subjects", {
    method: "POST",
    headers: json("dev-admin"),
    body: JSON.stringify({
      displayName: name,
      cid,
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
      fixtureId,
    }),
  });
  expect(res.status).toBe(201);
}

describe("subject access report", () => {
  it("lists one person's consents and audit activity, and audits the export", async () => {
    const { app, runtime } = await testApp();
    await enroll(app, AVERY, "Avery Quinn", "avery-quinn");
    await enroll(app, JORDAN, "Jordan Blake", "jordan-blake");

    // A gallery search names no subject; Avery shows up as a candidate.
    const search = await app.request("/v1/searches", {
      method: "POST",
      headers: json("dev-operator"),
      body: JSON.stringify({
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
      }),
    });
    expect(search.status).toBe(201);

    const path = `/v1/subjects/${encodeURIComponent(AVERY)}/access-report`;
    const res = await app.request(path, { headers: json("dev-auditor") });
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.subject).toMatchObject({ cid: AVERY, status: "active", template: { present: true } });
    expect(report.subject.consents[0]).toMatchObject({ purposeCode: "record_reconciliation", status: "granted" });
    const actions = report.activity.map((item: { action: string; involvement: string }) => `${item.action}:${item.involvement}`);
    expect(actions).toEqual(["enroll:named", "search:candidate"]);
    expect(JSON.stringify(report)).not.toMatch(/embedding|templateRef|storeKey|imageBase64/);

    const entries = await runtime.service.listAudit();
    const last = entries.at(-1)!;
    expect(last.action).toBe("subject_access");
    expect(last.attestation).toMatchObject({ subjectCid: AVERY, matchRan: false });
    expect(report.audit).toEqual({ seq: last.seq, hash: last.hash });
    expect((await runtime.service.verifyAudit()).ok).toBe(true);
  });

  it("is limited to admins and auditors, and 404s for an unknown CID", async () => {
    const { app } = await testApp();
    await enroll(app, AVERY, "Avery Quinn", "avery-quinn");
    const path = `/v1/subjects/${encodeURIComponent(AVERY)}/access-report`;
    for (const token of ["dev-operator", "dev-reviewer"]) {
      const res = await app.request(path, { headers: json(token) });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatchObject({ code: "FORBIDDEN", matchRan: false });
    }
    expect((await app.request(path, { headers: json("dev-admin") })).status).toBe(200);
    const missing = await app.request(`/v1/subjects/${encodeURIComponent("cid://infinitum/nobody-here")}/access-report`, {
      headers: json("dev-admin"),
    });
    expect(missing.status).toBe(404);
  });
});
