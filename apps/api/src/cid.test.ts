// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { cidActorSeeds, createCidVerifier, readCidConfig } from "./cid.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeIssuer(tokens: Record<string, { cid: string; username?: string }>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const profile = tokens[auth.replace(/^Bearer /, "")];
    return profile ? json(200, profile) : json(401, { error: "Not signed in" });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("Cumulus ID sign-in", () => {
  it("reads issuer and role lists from config, admin first", () => {
    const config = readCidConfig({
      CID_ISSUER: "https://mirror.example/",
      CID_ADMINS: "Alice, bob",
      CID_REVIEWERS: "bob carol",
    });
    expect(config.issuers).toEqual(["https://mirror.example"]);
    expect(config.roles.get("alice")).toBe("admin");
    expect(config.roles.get("bob")).toBe("admin");
    expect(config.roles.get("carol")).toBe("reviewer");
    expect(readCidConfig({}).issuers).toEqual(["https://id.cumuluscloud.app"]);
    expect(cidActorSeeds(config).map((seed) => seed.id)).toEqual(["cid:alice", "cid:bob", "cid:carol"]);
  });

  it("verifies the token at the issuer and maps the CID to a role", async () => {
    const issuer = fakeIssuer({ "tok-carol": { cid: "carol", username: "carol" }, "tok-dave": { cid: "dave" } });
    const verify = createCidVerifier(readCidConfig({ CID_REVIEWERS: "carol" }), { fetchImpl: issuer.fetchImpl });
    expect(await verify("tok-carol")).toMatchObject({ actor: { id: "cid:carol", role: "reviewer", displayName: "carol" } });
    expect(issuer.calls[0]).toBe("https://id.cumuluscloud.app/api/id/userinfo");
    expect(await verify("tok-dave")).toEqual({ noRole: { cid: "dave" } });
    expect(await verify("forged")).toBeNull();
    await verify("tok-carol");
    expect(issuer.calls.filter((url) => url.endsWith("/userinfo")).length).toBe(3); // carol was cached
  });

  it("tries the mirror only when the main issuer cannot be reached", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).startsWith("https://id.cumuluscloud.app")) throw new TypeError("network");
      return json(200, { cid: "alice" });
    }) as typeof fetch;
    const verify = createCidVerifier(readCidConfig({ CID_ISSUER_MIRROR: "https://ru.example", CID_ADMINS: "alice" }), { fetchImpl });
    expect(await verify("tok")).toMatchObject({ actor: { role: "admin" } });
    expect(calls).toEqual(["https://id.cumuluscloud.app/api/id/userinfo", "https://ru.example/api/id/userinfo"]);
  });

  it("answers 403 for a Cumulus ID without a role and shows the signed-in actor at /v1/me", async () => {
    const runtime = createMemoryRuntime();
    await seedReferenceData(runtime.repos, { demoMode: true });
    const app = createApp({
      service: runtime.service,
      repos: runtime.repos,
      authenticate: async (header) => {
        if (header === "Bearer tok-carol") return { id: "cid:carol", displayName: "carol", role: "reviewer" };
        if (header === "Bearer tok-dave") return { noRole: { cid: "dave" } };
        return null;
      },
      demoMode: true,
      matcherMode: "mock",
      milEnabled: false,
      dbPing: async () => true,
      adapters: { policy: "local" },
    });
    expect((await app.request("/v1/me")).status).toBe(401);
    expect((await app.request("/v1/me", { headers: { authorization: "Bearer dev-admin" } })).status).toBe(401);
    const noRole = await app.request("/v1/me", { headers: { authorization: "Bearer tok-dave" } });
    expect(noRole.status).toBe(403);
    expect((await noRole.json()).error.message).toMatch(/dave has no/);
    const me = await app.request("/v1/me", { headers: { authorization: "Bearer tok-carol" } });
    expect(me.status).toBe(200);
    expect((await me.json()).actor).toEqual({ id: "cid:carol", displayName: "carol", role: "reviewer" });
  });
});
