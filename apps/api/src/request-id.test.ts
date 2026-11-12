// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp, type AccessLogLine } from "./app.js";

async function testApp() {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const lines: AccessLogLine[] = [];
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
    accessLog: (line) => lines.push(line),
  });
  return { app, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("request ids and the access log", () => {
  it("issues an id, echoes a well-formed one, and replaces a malformed one", async () => {
    const { app } = await testApp();
    const fresh = await app.request("/v1/health");
    expect(fresh.headers.get("x-request-id")).toMatch(UUID);

    const echoed = await app.request("/v1/health", { headers: { "x-request-id": "trace-0001-abc" } });
    expect(echoed.headers.get("x-request-id")).toBe("trace-0001-abc");

    const hostile = await app.request("/v1/health", { headers: { "x-request-id": "bad id <script>" } });
    expect(hostile.headers.get("x-request-id")).toMatch(UUID);
  });

  it("puts the id in error bodies so a person can quote it", async () => {
    const { app } = await testApp();
    const anonymous = await app.request("/v1/subjects", { headers: { "x-request-id": "support-case-42" } });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { requestId: string } }).error.requestId).toBe("support-case-42");

    const invalid = await app.request("/v1/searches", {
      method: "POST",
      headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
      body: "{}",
    });
    const body = (await invalid.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe(invalid.headers.get("x-request-id"));
  });

  it("logs the route pattern, never the CID in the path, the query, or the token", async () => {
    const { app, lines } = await testApp();
    const cid = encodeURIComponent("cid://infinitum/fixture-avery-quinn");
    await app.request(`/v1/subjects/${cid}/withdraw?note=secret`, {
      method: "POST",
      headers: { authorization: "Bearer dev-admin", "x-request-id": "withdraw-trace-1" },
    });
    const line = lines.find((item) => item.requestId === "withdraw-trace-1");
    expect(line).toMatchObject({ level: "info", msg: "request", method: "POST", route: "/v1/subjects/:cid/withdraw", actorId: "actor-admin" });
    expect(typeof line?.status).toBe("number");
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toMatch(/fixture-avery-quinn|secret|dev-admin|Bearer/);

    await app.request("/nowhere");
    expect(lines.at(-1)).toMatchObject({ route: "(unmatched)", status: 404, actorId: null });
  });
});
