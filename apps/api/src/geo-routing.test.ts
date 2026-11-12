// © Infinitum Corporation®. All rights reserved.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { buildSyntheticGeoFixtures, V2RayGeoDataset } from "@eidetic/geo";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { createGeoRouting } from "./geo-routing.js";

const admin = { authorization: "Bearer dev-admin", "content-type": "application/json" };
const operator = { authorization: "Bearer dev-operator", "content-type": "application/json" };

function appWithGeo(processOptIn: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "eidetic-geo-api-"));
  const fixtures = buildSyntheticGeoFixtures();
  const logs: Array<Record<string, unknown>> = [];
  const geoRouting = createGeoRouting({
    processOptIn,
    dataDir: dir,
    settingsPath: path.join(dir, "settings.json"),
    log: (line) => logs.push(line),
    loadDataset: () => V2RayGeoDataset.fromBytes(fixtures.geoip, fixtures.geosite),
  });
  const runtime = createMemoryRuntime({
    annotatePolicy: processOptIn ? (decision, routing) => geoRouting.annotatePolicy(decision, routing) : undefined,
  });
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
    geoRouting,
  });
  return { app, geoRouting, logs, runtime };
}

describe("geo routing hook", () => {
  it("keeps search results unchanged while the toggle is off", async () => {
    const { app, runtime } = appWithGeo(true);
    await seedReferenceData(runtime.repos, { demoMode: true });
    const before = await app.request("/v1/settings/geo-routing", { headers: admin });
    expect(await before.json()).toMatchObject({ geoRouting: false, processOptIn: true, active: false, identityMatch: false });
    const edition = await app.request("/v1/edition", { headers: admin });
    expect((await edition.json()).adapters.geoRouting).toBe("off");

    const enrolled = await app.request("/v1/subjects", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        displayName: "Avery Quinn",
        cid: "cid://infinitum/fixture-avery-quinn",
        legalBasis: "consent",
        purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
        fixtureId: "avery-quinn",
      }),
    });
    expect(enrolled.status).toBe(201);
    const search = await app.request("/v1/searches", {
      method: "POST",
      headers: operator,
      body: JSON.stringify({
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
        routing: { ip: "1.2.3.4", domain: "mail.google.com" },
      }),
    });
    expect(search.status).toBe(201);
    const body = await search.json();
    expect(body.candidates[0].confidence).toBe(0.97);
    expect(body.geoRouting).toBeUndefined();
    const lookup = await app.request("/v1/geo/lookup", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ ip: "1.2.3.4" }),
    });
    expect(lookup.status).toBe(403);
    const operatorWrite = await app.request("/v1/settings/geo-routing", {
      method: "PUT",
      headers: operator,
      body: JSON.stringify({ geoRouting: true }),
    });
    expect(operatorWrite.status).toBe(403);
  });

  it("annotates country and site category without matching identity", async () => {
    const { app, runtime, logs } = appWithGeo(true);
    await seedReferenceData(runtime.repos, { demoMode: true });
    const saved = await app.request("/v1/settings/geo-routing", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ geoRouting: true }),
    });
    expect(await saved.json()).toMatchObject({ geoRouting: true, processOptIn: true, active: true, identityMatch: false });
    await app.request("/v1/subjects", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        displayName: "Avery Quinn",
        cid: "cid://infinitum/fixture-avery-quinn",
        legalBasis: "consent",
        purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
        fixtureId: "avery-quinn",
      }),
    });
    const search = await app.request("/v1/searches", {
      method: "POST",
      headers: operator,
      body: JSON.stringify({
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
        recordHints: { site: "Washington" },
        routing: { ip: "1.2.3.4", domain: "mail.google.com" },
      }),
    });
    const body = await search.json();
    expect(body.candidates[0].confidence).toBe(0.97);
    expect(body.geoRouting).toEqual({
      countryCode: "CA",
      categories: ["google", "workspace"],
      usedForIdentityMatch: false,
    });
    const audit = await app.request("/v1/audit", { headers: { authorization: "Bearer dev-auditor" } });
    const serialized = JSON.stringify(await audit.json());
    expect(serialized).not.toContain("1.2.3.4");
    expect(serialized).not.toContain("mail.google.com");
    expect(JSON.stringify(logs)).not.toContain("1.2.3.4");
    expect(JSON.stringify(logs)).not.toContain("mail.google.com");
    const lookup = await app.request("/v1/geo/lookup", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ domain: "cid://infinitum/someone" }),
    });
    expect(lookup.status).toBe(403);
    expect(await lookup.json()).toMatchObject({ error: { code: "PERSON_TRACKING_REFUSED", matchRan: false } });
    const identitySearch = await app.request("/v1/searches", {
      method: "POST",
      headers: operator,
      body: JSON.stringify({
        purposeCode: "record_reconciliation",
        legalBasis: "consent",
        datasetId: "workforce_records",
        edition: "business",
        fixtureId: "avery-quinn",
        routing: { domain: "cid://infinitum/someone" },
      }),
    });
    expect(identitySearch.status).toBe(201);
    const identityBody = await identitySearch.json();
    expect(identityBody.candidates[0].confidence).toBe(0.97);
    expect(identityBody.geoRouting).toBeUndefined();
    expect(JSON.stringify(logs)).toContain("Identity matching is refused");
  });

  it("does nothing when the process opt-in is off", async () => {
    const { app, runtime } = appWithGeo(false);
    await seedReferenceData(runtime.repos, { demoMode: true });
    const saved = await app.request("/v1/settings/geo-routing", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ geoRouting: true }),
    });
    expect(await saved.json()).toMatchObject({ geoRouting: true, processOptIn: false, active: false });
    const lookup = await app.request("/v1/geo/lookup", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ ip: "1.2.3.5" }),
    });
    expect(lookup.status).toBe(403);
  });
});
