// © Infinitum Corporation®. All rights reserved.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData } from "@eidetic/pipeline";
import { createApp, REQUEST_SCHEMAS } from "./app.js";
import { buildOpenApi, ROUTES } from "./openapi.js";

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
  });
}

describe("OpenAPI document", () => {
  it("documents every route the API registers, and nothing it does not", async () => {
    const app = await testApp();
    const served = new Set(
      app.routes
        .filter((route) => route.method !== "ALL" && !route.path.endsWith("/*"))
        .map((route) => `${route.method} ${route.path}`),
    );
    const documented = new Set(ROUTES.map((route) => `${route.method.toUpperCase()} ${route.path}`));
    expect([...served].filter((route) => !documented.has(route))).toEqual([]);
    expect([...documented].filter((route) => !served.has(route))).toEqual([]);
  });

  it("points every request body at a schema the routes parse with", () => {
    const doc = buildOpenApi(REQUEST_SCHEMAS) as { components: { schemas: Record<string, { type?: string; properties?: object }> } };
    for (const route of ROUTES) {
      for (const key of [route.body, route.query].filter(Boolean) as string[]) {
        expect(doc.components.schemas[key]?.type).toBe("object");
      }
    }
    // Defaults make a field optional for the caller.
    expect((doc.components.schemas.SearchRequest as { required?: string[] }).required).not.toContain("edition");
  });

  it("is served to signed-in callers", async () => {
    const app = await testApp();
    expect((await app.request("/v1/openapi.json")).status).toBe(401);
    const res = await app.request("/v1/openapi.json", { headers: { authorization: "Bearer dev-auditor" } });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/subjects/{cid}/withdraw"]).toBeDefined();
  });

  it("matches the committed docs/openapi.json (run pnpm openapi after changing a route)", () => {
    const committed = readFileSync(path.resolve(process.cwd(), "docs/openapi.json"), "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(`${JSON.stringify(buildOpenApi(REQUEST_SCHEMAS), null, 2)}\n`);
  });
});
