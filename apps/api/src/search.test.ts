// © Infinitum Corporation®. All rights reserved.
// @search on the ei·det·ic API: actor sign-in, a fake search engine and model, and the MIL exclusion.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { createSearch, createSearchRoutes } from "./search/search.mjs";

const pages = (async (url: string) =>
  url.endsWith("/robots.txt")
    ? new Response("", { status: 404 })
    : new Response(`<title>Doc</title><article>${"Public guidance on consent. ".repeat(20)}</article>`, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

async function testApp({ milEnabled = false, connected = true } = {}) {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const search = connected
    ? createSearchRoutes({
        prefix: "/v1/search",
        search: createSearch({
          engines: [{ name: "test", search: async () => [{ title: "Doc", url: "https://doc.example/consent", snippet: "consent" }] }],
          fetch: pages,
          chat: async () => "Consent must be recorded [1].",
        }),
      })
    : null;
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
    search,
  });
}

const H = { authorization: "Bearer dev-operator", "content-type": "application/json" }; // demo seed actor
const ask = (app: Awaited<ReturnType<typeof testApp>>, text: string) => app.request("/v1/search", { method: "POST", headers: H, body: JSON.stringify({ text }) });

describe("@search", () => {
  it("needs a signed-in actor", async () => {
    const app = await testApp();
    expect((await app.request("/v1/search", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("answers with numbered sources", async () => {
    const r = await (await ask(await testApp(), "@search what does consent need?")).json();
    expect(r.mention).toBe(true);
    expect(r.answer).toBe("Consent must be recorded [1].");
    expect(r.sources[0].url).toBe("https://doc.example/consent");
  });

  it("is off when not configured and on MIL deployments", async () => {
    expect((await ask(await testApp({ connected: false }), "@search x")).status).toBe(503);
    expect((await ask(await testApp({ milEnabled: true }), "@search x")).status).toBe(403);
  });
});
