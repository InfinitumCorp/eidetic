// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp, MAX_BODY_BYTES } from "./app.js";
import { readAllowedOrigins } from "./env.js";

async function testApp(allowedOrigins?: string[]) {
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
    allowedOrigins,
  });
}

describe("HTTP hardening", () => {
  it("sends security headers and keeps API responses out of caches", async () => {
    const app = await testApp();
    const res = await app.request("/v1/purposes", { headers: { authorization: "Bearer dev-admin" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a body over the limit before reading it as JSON", async () => {
    const app = await testApp();
    const res = await app.request("/v1/searches", {
      method: "POST",
      headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatchObject({ code: "VALIDATION", matchRan: false });
  });

  it("allows only the configured browser origins", async () => {
    const app = await testApp(["https://desk.example.com"]);
    const allowed = await app.request("/v1/health", { headers: { origin: "https://desk.example.com" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://desk.example.com");
    const local = await app.request("/v1/health", { headers: { origin: "http://127.0.0.1:43111" } });
    expect(local.headers.get("access-control-allow-origin")).toBeNull();

    const defaults = await testApp();
    const desk = await defaults.request("/v1/health", { headers: { origin: "http://127.0.0.1:43111" } });
    expect(desk.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:43111");
  });

  it("parses ALLOWED_ORIGINS and rejects anything that is not a bare origin", () => {
    expect(readAllowedOrigins(undefined)).toBeUndefined();
    expect(readAllowedOrigins(" ")).toBeUndefined();
    expect(readAllowedOrigins("https://a.example.com, http://127.0.0.1:43111")).toEqual([
      "https://a.example.com",
      "http://127.0.0.1:43111",
    ]);
    expect(() => readAllowedOrigins("https://a.example.com/desk")).toThrow(/bare origins/);
    expect(() => readAllowedOrigins("*")).toThrow(/not a URL/);
    expect(() => readAllowedOrigins("ftp://a.example.com")).toThrow(/bare origins/);
  });
});
