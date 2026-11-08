// © Infinitum Corporation®. All rights reserved.
// @conjure on the ei·det·ic API: actor sign-in, a fake Conjure service, and the MIL exclusion.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { createConjure, createConjureRoutes } from "./conjure/conjure.mjs";

const sent: any[] = [];
const fakeConjure = (async (_url: string, init: RequestInit) => {
  const p = { id: "pr_3", product: "eidetic", question: "will review backlog clear this week?", agents: 8, rounds: 2, stats: [], createdAt: "2026-11-08T00:00:00Z", poles: { for: "the backlog clears", against: "no" } };
  if (init.method === "POST") { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ...p, status: "queued", round: 0 }), { status: 202 }); }
  return new Response(JSON.stringify({ ...p, status: "done", round: 2, report: { outcome: "Clears.", probability: 0.64, confidence: "medium", forecast: "", drivers: [], signals: [], assumptions: [] } }));
}) as unknown as typeof fetch;

async function testApp(milEnabled = false) {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const conjure = createConjureRoutes({ conjure: createConjure({ url: "https://conjure.test", key: "cjp_eidetic_x", fetch: fakeConjure }), secret: "cjp_eidetic_x", prefix: "/v1/conjure", source: "eidetic" });
  return createApp({
    service: runtime.service,
    repos: runtime.repos,
    authenticate: async (header) => {
      if (!header?.startsWith("Bearer ")) return null;
      return runtime.repos.actors.findByTokenHash(sha256Hex(header.slice("Bearer ".length).trim()));
    },
    demoMode: true,
    matcherMode: "mock",
    milEnabled,
    dbPing: async () => true,
    adapters: { policy: "local" },
    conjure,
  });
}

const TOKEN = "dev-operator"; // demo seed actor

describe("@conjure", () => {
  it("needs a signed-in actor", async () => {
    const app = await testApp();
    expect((await app.request("/v1/conjure", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("starts a forecast for the actor and follows it", async () => {
    const app = await testApp();
    const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    expect(await (await app.request("/v1/conjure", { method: "POST", headers: H, body: JSON.stringify({ text: "no mention" }) })).json()).toEqual({ mention: false });
    const r = await (await app.request("/v1/conjure", { method: "POST", headers: H, body: JSON.stringify({ text: "@conjure will review backlog clear this week?" }) })).json();
    expect(r.mention).toBe(true);
    expect(sent[0]).toMatchObject({ question: "will review backlog clear this week?", source: "eidetic" });
    const live = await (await app.request(`/v1/conjure/${r.ticket}`, { headers: H })).json();
    expect(live.text).toMatch(/64% likely that the backlog clears/);
  });

  it("is off on MIL deployments", async () => {
    const app = await testApp(true);
    const res = await app.request("/v1/conjure", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ text: "@conjure q?" }) });
    expect(res.status).toBe(403);
  });
});
