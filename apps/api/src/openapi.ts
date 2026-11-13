// © Infinitum Corporation®. All rights reserved.

import { z } from "zod";
import { PRODUCT } from "@eidetic/contracts";

type Method = "get" | "post" | "put";
type Role = "admin" | "operator" | "reviewer" | "auditor";

export interface RouteDoc {
  method: Method;
  /** Hono pattern, e.g. /v1/subjects/:cid/withdraw. */
  path: string;
  tag: string;
  summary: string;
  /** Who may call it. Omitted: any signed-in role. */
  roles?: Role[];
  /** Key into the request schemas. */
  body?: string;
  query?: string;
  status?: number;
  /** No bearer token needed. */
  open?: boolean;
}

/**
 * Every route the API serves. A test compares this list with the routes Hono registered, so a new route cannot
 * ship undocumented. Assistant passthroughs (@conjure, @scalvs, @search) are listed once each.
 */
export const ROUTES: RouteDoc[] = [
  { method: "get", path: "/v1/health", tag: "Service", summary: "Liveness and database status. 503 when the database is down.", open: true },
  { method: "get", path: "/v1/openapi.json", tag: "Service", summary: "This document." },
  { method: "get", path: "/v1/me", tag: "Service", summary: "The signed-in actor and role." },
  { method: "get", path: "/v1/edition", tag: "Service", summary: "Product, MIL status and adapter names." },
  { method: "get", path: "/v1/seams", tag: "Service", summary: "External systems and whether each is wired, mocked or off." },
  { method: "get", path: "/v1/sites/:assetId", tag: "Service", summary: "Describe a site asset." },

  { method: "get", path: "/v1/settings/geo-routing", tag: "Geo routing", summary: "Whether country and site-category labels are on." },
  { method: "put", path: "/v1/settings/geo-routing", tag: "Geo routing", summary: "Turn geo routing on or off.", roles: ["admin"], body: "GeoRoutingSettings" },
  { method: "post", path: "/v1/geo/lookup", tag: "Geo routing", summary: "Label an IP or domain. Never used for identity matching.", roles: ["admin"], body: "GeoLookupRequest" },

  { method: "get", path: "/v1/purposes", tag: "Purposes", summary: "Published purposes." },
  { method: "post", path: "/v1/purposes", tag: "Purposes", summary: "Publish or edit a purpose. Audited.", roles: ["admin"], body: "PurposeRequest", status: 201 },

  { method: "get", path: "/v1/subjects", tag: "Subjects and consent", summary: "Enrolled subjects and their consent.", roles: ["admin", "auditor"] },
  { method: "post", path: "/v1/subjects", tag: "Subjects and consent", summary: "Enroll a subject with consent per purpose. Audited.", roles: ["admin"], body: "EnrollRequest", status: 201 },
  { method: "get", path: "/v1/subjects/:cid/access-report", tag: "Subjects and consent", summary: "Subject access report: consents and audit activity. The export is audited.", roles: ["admin", "auditor"] },
  { method: "post", path: "/v1/subjects/:cid/withdraw", tag: "Subjects and consent", summary: "Withdraw all consent and purge the sealed template. Audited.", roles: ["admin"] },
  { method: "post", path: "/v1/subjects/:cid/consents/:purposeCode/withdraw", tag: "Subjects and consent", summary: "Withdraw consent for one purpose. Withdrawing the last one is a full withdrawal and purges the template. Audited.", roles: ["admin"] },
  { method: "post", path: "/v1/consents/sweep", tag: "Subjects and consent", summary: "Purge templates whose consent has all lapsed. Audited per subject.", roles: ["admin"] },

  { method: "post", path: "/v1/searches", tag: "Search and review", summary: "Run a consent-checked search. Results are unconfirmed until a reviewer decides. Audited.", body: "SearchRequest", status: 201 },
  { method: "get", path: "/v1/searches/allowance", tag: "Search and review", summary: "The caller's searches left this hour. A hint only; the limit is enforced on every search." },
  { method: "get", path: "/v1/reviews", tag: "Search and review", summary: "Review queue. ?status=pending|decided. Operators see only their own searches." },
  { method: "get", path: "/v1/reviews/:id", tag: "Search and review", summary: "One review with its candidates." },
  { method: "post", path: "/v1/reviews/:id/decide", tag: "Search and review", summary: "Record a reviewer's decision. The searcher cannot decide their own search. Audited.", roles: ["reviewer"], body: "DecisionRequest" },

  { method: "get", path: "/v1/stats/usage", tag: "Audit", summary: "Searches run and refused, refusal codes, decisions and pending reviews over the last ?hours= (1 to 2160, default 24). No biometric data.", roles: ["admin", "auditor"], query: "UsageQuery" },
  { method: "get", path: "/v1/audit", tag: "Audit", summary: "The hash-chained audit log, newest first, paged.", roles: ["admin", "auditor"], query: "AuditQuery" },
  { method: "get", path: "/v1/audit/verify", tag: "Audit", summary: "Recompute the hash chain and Merkle checkpoints." },
  { method: "get", path: "/v1/audit/export", tag: "Audit", summary: "The whole log as a signed export, verifiable offline. Taking it is audited, and the file includes that entry.", roles: ["admin", "auditor"] },

  { method: "post", path: "/v1/bias/evaluations", tag: "Bias", summary: "Record a bias evaluation for a model release.", roles: ["admin"], body: "BiasEvaluationRequest", status: 201 },
  { method: "post", path: "/v1/bias/fixture-evaluations", tag: "Bias", summary: "Run a bias evaluation over synthetic fixtures.", roles: ["admin"], body: "BiasFixtureEvaluationRequest", status: 201 },
  { method: "get", path: "/v1/bias/evaluations/:releaseId", tag: "Bias", summary: "A recorded bias report.", roles: ["admin", "auditor"] },

  { method: "post", path: "/v1/demo/seed", tag: "Demo", summary: "Seed the synthetic review queue. Only when DEMO_MODE is on.", roles: ["admin"], status: 201 },

  { method: "get", path: "/v1/conjure", tag: "Assistants", summary: "@conjure passthrough. Only the actor's text leaves. Off on MIL." },
  { method: "post", path: "/v1/conjure", tag: "Assistants", summary: "@conjure passthrough. Only the actor's text leaves. Off on MIL." },
  { method: "get", path: "/v1/openclaw", tag: "Assistants", summary: "@scalvs passthrough. Only the actor's text leaves. Off on MIL." },
  { method: "post", path: "/v1/openclaw", tag: "Assistants", summary: "@scalvs passthrough. Only the actor's text leaves. Off on MIL." },
  { method: "get", path: "/v1/search", tag: "Assistants", summary: "@search passthrough: a web answer with numbered sources. Off on MIL." },
  { method: "post", path: "/v1/search", tag: "Assistants", summary: "@search passthrough: a web answer with numbered sources. Off on MIL." },
];

const ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "matchRan", "requestId"],
      properties: {
        code: { type: "string", description: "A stable code such as CONSENT_REQUIRED, FORBIDDEN or VALIDATION." },
        message: { type: "string", description: "A sentence a person can act on." },
        matchRan: { type: "boolean", description: "Whether a biometric match ran before the refusal. Almost always false." },
        requestId: { type: "string", description: "Matches the X-Request-Id header. Quote it when asking for support." },
      },
    },
  },
};

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, "{$1}");
}

/** Build the OpenAPI 3.1 document from the route list and the zod schemas the routes parse with. */
export function buildOpenApi(schemas: Record<string, z.ZodType>): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete json.$schema;
    components[name] = json;
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const path = toOpenApiPath(route.path);
    const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (route.query) {
      const query = components[route.query] as { properties?: Record<string, unknown> };
      for (const [name, schema] of Object.entries(query.properties ?? {})) params.push({ name, in: "query", required: false, schema: schema as { type: string } });
    }
    const status = String(route.status ?? 200);
    const roles = route.roles ? `Roles: ${route.roles.join(", ")}.` : route.open ? "No sign-in needed." : "Any signed-in role.";
    paths[path] ??= {};
    paths[path][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      description: roles,
      operationId: `${route.method}${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ?? "").toUpperCase())}`,
      ...(route.open ? { security: [] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(route.body
        ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${route.body}` } } } } }
        : {}),
      responses: {
        [status]: { description: "OK", headers: { "X-Request-Id": { $ref: "#/components/headers/RequestId" } }, content: { "application/json": {} } },
        ...(route.open ? {} : { "401": { $ref: "#/components/responses/Error" }, "403": { $ref: "#/components/responses/Error" } }),
        ...(route.body || route.query ? { "422": { $ref: "#/components/responses/Error" } } : {}),
        default: { $ref: "#/components/responses/Error" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${PRODUCT} API`,
      version: "1",
      description:
        "Consent-first identity matching. A search runs only when purpose, legal basis and consent allow it; every attempt is audited; a match is never final until a person decides.",
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    tags: [...new Set(ROUTES.map((route) => route.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A Cumulus ID session token." } },
      headers: { RequestId: { description: "The caller's well-formed X-Request-Id, or a new one.", schema: { type: "string" } } },
      responses: { Error: { description: "Refused or failed. The body says whether a match ran.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
      schemas: { Error: ERROR_SCHEMA, ...components },
    },
  };
}
