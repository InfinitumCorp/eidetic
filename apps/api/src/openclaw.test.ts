// © Infinitum Corporation®. All rights reserved.
// @scalvs / @scalus on the ei·det·ic API: actor sign-in, a fake OpenClaw gateway, and the MIL exclusion.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { createOpenClaw, createOpenClawRoutes } from "./openclaw/openclaw.mjs";

const sent: any[] = [];
const gateway = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Review queue summarised: 4 cases waiting." } }] }));
}) as unknown as typeof fetch;

async function testApp({ milEnabled = false, connected = true } = {}) {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const openclaw = createOpenClawRoutes({
    openclaw: connected ? createOpenClaw({ url: "https://claw.test", token: "tok_secret", agent: "openclaw/review", fetch: gateway }) : null,
    prefix: "/v1/openclaw",
    product: "eidetic",
  });
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
    openclaw,
  });
}

const H = { authorization: "Bearer dev-operator", "content-type": "application/json" }; // demo seed actor
const ask = (app: Awaited<ReturnType<typeof testApp>>, text: string) => app.request("/v1/openclaw", { method: "POST", headers: H, body: JSON.stringify({ text }) });

describe("@scalvs / @scalus", () => {
  it("needs a signed-in actor", async () => {
    const app = await testApp();
    expect((await app.request("/v1/openclaw", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("hands only the actor's text to the SCALVS agent, as that actor", async () => {
    const app = await testApp();
    const r = await (await ask(app, "@scalvs summarise the review queue")).json();
    expect(r).toEqual({ mention: true, text: "Review queue summarised: 4 cases waiting.", agent: "openclaw/review" });
    const req = sent.at(-1);
    expect(req.model).toBe("openclaw/review");
    expect(req.user).toMatch(/^eidetic:/);
    expect(req.messages).toEqual([{ role: "user", content: "summarise the review queue" }]);
    expect((await (await ask(app, "@scalus what's next?")).json()).mention).toBe(true);
  });

  it("does not trigger on @openclaw or plain text", async () => {
    const app = await testApp();
    expect(await (await ask(app, "@openclaw summarise")).json()).toEqual({ mention: false });
    expect(await (await ask(app, "no mention")).json()).toEqual({ mention: false });
  });

  it("reports the connection without the gateway URL or token", async () => {
    const app = await testApp();
    const body = await (await app.request("/v1/openclaw", { headers: H })).text();
    expect(JSON.parse(body)).toEqual({ connected: true, agent: "openclaw/review" });
    expect(body).not.toContain("tok_secret");
  });

  it("is off until configured and says how to connect", async () => {
    const app = await testApp({ connected: false });
    const res = await ask(app, "@scalvs summarise");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/OPENCLAW_GATEWAY_URL/);
  });

  it("is off on MIL deployments", async () => {
    const app = await testApp({ milEnabled: true });
    expect((await ask(app, "@scalvs summarise")).status).toBe(403);
  });
});
