// © Infinitum Corporation®. All rights reserved.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  COMPANY,
  CONTACT_EMAIL,
  CONTACT_PHONE,
  EideticError,
  MIL_PRODUCT,
  PRODUCT,
  type Actor,
} from "@eidetic/contracts";
import { syntheticFixture } from "@eidetic/matcher";
import { seedSyntheticQueue, type EideticService, type Repositories } from "@eidetic/pipeline";
import { describeSiteAsset } from "@eidetic/geo";
import { SEAMS } from "@eidetic/seams";
import type { ConjureRouteHandler } from "./conjure/conjure.mjs";
import type { OpenClawRouteHandler } from "./openclaw/openclaw.mjs";

const allowedOrigins = new Set([
  "http://127.0.0.1:43111",
  "http://localhost:43111",
  "http://127.0.0.1:43112",
  "http://localhost:43112",
]);

const code = z.string().regex(/^[a-z][a-z0-9_]{2,64}$/);
const legalBasis = z.enum(["consent", "contract", "legal_obligation"]);
const attributes = z.record(z.string(), z.string().max(80)).optional();

const enrollBody = z.object({
  displayName: z.string().min(1).max(80),
  cid: z.string().regex(/^cid:\/\/infinitum\/[a-z0-9-]{3,80}$/).optional(),
  legalBasis,
  purposes: z.array(z.object({ purposeCode: code, datasetIds: z.array(code).min(1) })).min(1),
  recordAttributes: attributes,
  fixtureId: z.string().regex(/^[a-z0-9-]{3,64}$/).optional(),
  imageBase64: z.string().max(700_000).optional(),
});

const searchBody = z.object({
  purposeCode: z.string().min(1).max(80),
  legalBasis,
  datasetId: z.string().min(1).max(80),
  edition: z.enum(["civilian", "business", "mil"]).default("business"),
  subjectCid: z.string().min(8).max(120).optional(),
  recordHints: attributes,
  fixtureId: z.string().regex(/^[a-z0-9-]{3,64}$/).optional(),
  imageBase64: z.string().max(700_000).optional(),
});

const purposeBody = z.object({
  code,
  title: z.string().min(3).max(80),
  description: z.string().min(8).max(400),
  edition: z.enum(["civilian", "business"]),
  legalBases: z.array(legalBasis).min(1),
  datasetIds: z.array(code).min(1),
  allowedRoles: z.array(z.enum(["admin", "operator", "reviewer", "auditor"])).min(1),
  active: z.boolean().default(true),
});

const decisionBody = z.object({
  decision: z.enum(["confirm", "reject", "inconclusive"]),
  selectedCid: z.string().min(8).max(120).optional(),
  notes: z.string().min(8).max(2000),
});

const biasBody = z.object({
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,64}$/),
  cases: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        group: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
        expectedCid: z.string().min(8).max(120).nullable(),
        predictedCid: z.string().min(8).max(120).nullable(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(500),
});

export interface AppDeps {
  service: EideticService;
  repos: Repositories;
  authenticate: (header: string | undefined) => Promise<Actor | { noRole: { cid: string } } | null>;
  demoMode: boolean;
  matcherMode: string;
  milEnabled: boolean;
  dbPing: () => Promise<boolean>;
  adapters: Record<string, string>;
  /** @conjure live forecasts (prefix /v1/conjure). Off when unset and on MIL deployments. */
  conjure?: ConjureRouteHandler | null;
  /** @scalvs / @scalus: the SCALVS agent on an OpenClaw gateway (prefix /v1/openclaw). Off when unset and on MIL deployments. */
  openclaw?: OpenClawRouteHandler | null;
}

type Variables = { actor: Actor };

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use(
    "*",
    cors({
      origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : ""),
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  app.get("/v1/health", async (c) => {
    const db = await deps.dbPing();
    return c.json(
      {
        ok: db,
        product: PRODUCT,
        company: COMPANY,
        phone: CONTACT_PHONE,
        email: CONTACT_EMAIL,
        matcher: deps.matcherMode,
        demoMode: deps.demoMode,
        milEnabled: deps.milEnabled,
        db: db ? "ok" : "down",
      },
      db ? 200 : 503,
    );
  });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const actor = await deps.authenticate(c.req.header("authorization"));
    if (!actor) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Sign in with Cumulus ID.",
            matchRan: false,
          },
        },
        401,
      );
    }
    if ("noRole" in actor) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Cumulus ID ${actor.noRole.cid} has no ei·det·ic™ role. Ask an admin to add it.`,
            matchRan: false,
          },
        },
        403,
      );
    }
    c.set("actor", actor);
    return next();
  });

  // Who is signed in, and with which role. The desks use it to show the right controls.
  app.get("/v1/me", (c) => c.json({ actor: c.get("actor"), demoMode: deps.demoMode }));

  // "@conjure <question>" from the operator consoles: a live Conjure forecast.
  // Only the text the actor sends goes to Conjure; no subject, template or match data.
  app.on(["GET", "POST"], ["/v1/conjure", "/v1/conjure/*"], async (c) => {
    if (deps.milEnabled) {
      return c.json({ error: { code: "CONJURE_UNAVAILABLE", message: "@conjure is not available on MIL deployments.", matchRan: false } }, 403);
    }
    const res = deps.conjure ? await deps.conjure(c.req.raw, { user: c.get("actor").id }) : null;
    return res ?? c.json({ error: { code: "CONJURE_UNAVAILABLE", message: "@conjure is not configured here.", matchRan: false } }, 503);
  });

  // "@scalvs <task>" (or "@scalus") from the operator consoles: the SCALVS agent on OpenClaw answers.
  // Same rule as @conjure: only the text the actor sends goes out; no subject, template or match data.
  app.on(["GET", "POST"], "/v1/openclaw", async (c) => {
    if (deps.milEnabled) {
      return c.json({ error: { code: "SCALVS_UNAVAILABLE", message: "@scalvs is not available on MIL deployments.", matchRan: false } }, 403);
    }
    const res = deps.openclaw ? await deps.openclaw(c.req.raw, { user: c.get("actor").id }) : null;
    return res ?? c.json({ error: { code: "SCALVS_UNAVAILABLE", message: "@scalvs is not configured here.", matchRan: false } }, 503);
  });

  app.get("/v1/edition", (c) =>
    c.json({
      product: PRODUCT,
      company: COMPANY,
      mil: { product: MIL_PRODUCT, enabled: deps.milEnabled, workflows: "not_implemented" },
      adapters: deps.adapters,
    }),
  );

  app.get("/v1/seams", (c) => c.json({ seams: SEAMS }));
  app.get("/v1/sites/:assetId", (c) => c.json(describeSiteAsset(c.req.param("assetId"))));
  app.get("/v1/purposes", async (c) => c.json({ purposes: await deps.service.listPurposes() }));
  app.post("/v1/purposes", async (c) => {
    const body = parse(purposeBody, await readJson(c));
    const purpose = await deps.service.createPurpose(c.get("actor"), { ...body, active: body.active ?? true });
    return c.json({ purpose }, 201);
  });

  app.get("/v1/subjects", async (c) => c.json({ subjects: await deps.service.listSubjects() }));
  app.post("/v1/subjects", async (c) => {
    const body = parse(enrollBody, await readJson(c));
    const image = probeBytes(body.fixtureId, body.imageBase64, deps.demoMode);
    const enrolled = await deps.service.enroll({ actor: c.get("actor"), ...body, image });
    return c.json(enrolled, 201);
  });
  app.post("/v1/subjects/:cid/withdraw", async (c) => {
    const subject = await deps.service.withdraw(c.get("actor"), c.req.param("cid"));
    return c.json({ subject });
  });

  app.post("/v1/searches", async (c) => {
    const body = parse(searchBody, await readJson(c));
    const image = probeBytes(body.fixtureId, body.imageBase64, deps.demoMode);
    const result = await deps.service.search({
      actor: c.get("actor"),
      purposeCode: body.purposeCode,
      legalBasis: body.legalBasis,
      datasetId: body.datasetId,
      edition: body.edition ?? "business",
      subjectCid: body.subjectCid,
      recordHints: body.recordHints,
      image,
    });
    return c.json(result, 201);
  });

  app.get("/v1/reviews", async (c) => {
    const status = c.req.query("status");
    const filter = status === "pending" || status === "decided" ? status : undefined;
    return c.json({ reviews: await deps.service.listReviews(filter) });
  });
  app.get("/v1/reviews/:id", async (c) => c.json(await deps.service.getReview(c.req.param("id"))));
  app.post("/v1/reviews/:id/decide", async (c) => {
    const body = parse(decisionBody, await readJson(c));
    const result = await deps.service.decide({ actor: c.get("actor"), reviewId: c.req.param("id"), ...body });
    return c.json(result);
  });

  // Newest first. ?limit= (1-500, default 50), ?before=<seq> for the next page, ?action= to filter.
  app.get("/v1/audit", async (c) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        before: z.coerce.number().int().min(1).optional(),
        action: z.string().regex(/^[a-z_]{1,40}$/).optional(),
      }),
      c.req.query(),
    );
    return c.json(await deps.service.pageAudit({ limit: query.limit, beforeSeq: query.before, action: query.action }));
  });
  app.get("/v1/audit/verify", async (c) => c.json(await deps.service.verifyAudit()));

  app.post("/v1/bias/fixture-evaluations", async (c) => {
    const body = parse(
      z.object({
        releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,64}$/),
        cases: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              fixtureId: z.string().regex(/^[a-z0-9-]{3,64}$/),
              expectedCid: z.string().min(8).max(120).nullable(),
              predictedCid: z.string().min(8).max(120).nullable(),
              confidence: z.number().min(0).max(1),
            }),
          )
          .min(1)
          .max(500),
      }),
      await readJson(c),
    );
    return c.json(await deps.service.runFixtureBias(c.get("actor"), body.releaseId, body.cases), 201);
  });
  app.post("/v1/bias/evaluations", async (c) => {
    const body = parse(biasBody, await readJson(c));
    const report = await deps.service.runBias(c.get("actor"), body.releaseId, body.cases);
    return c.json(report, 201);
  });
  app.get("/v1/bias/evaluations/:releaseId", async (c) => c.json(await deps.service.getBias(c.req.param("releaseId"))));

  app.post("/v1/demo/seed", async (c) => {
    if (!deps.demoMode) {
      throw new EideticError("FORBIDDEN", "Synthetic demo seed is disabled while DEMO_MODE is false.", 403, false);
    }
    const actor = c.get("actor");
    if (actor.role !== "admin") {
      throw new EideticError("FORBIDDEN", "An admin actor has to start the synthetic demo.", 403, false);
    }
    const operator = await deps.repos.actors.get("actor-operator");
    if (!operator) throw new EideticError("POLICY_UNAVAILABLE", "Demo operator is not seeded.", 500, false);
    const seeded = await seedSyntheticQueue(deps.service, { admin: actor, operator });
    return c.json(seeded, 201);
  });

  app.onError((error, c) => {
    if (error instanceof EideticError) {
      return c.json({ error: { code: error.code, message: error.message, matchRan: error.matchRan } }, errorStatus(error.httpStatus));
    }
    if (error instanceof z.ZodError) {
      return c.json(
        { error: { code: "VALIDATION", message: error.issues.map((issue) => issue.message).join("; "), matchRan: false } },
        422,
      );
    }
    console.error(JSON.stringify({ level: "error", code: "INTERNAL", name: error.name }));
    return c.json({ error: { code: "INTERNAL", message: "The request failed closed.", matchRan: false } }, 500);
  });

  return app;
}

function errorStatus(status: number): 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 502 {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 422 || status === 501 || status === 502) {
    return status;
  }
  return 500;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new EideticError("VALIDATION", "Request body must be JSON.", 422, false);
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new EideticError(
      "VALIDATION",
      result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
      422,
      false,
    );
  }
  return result.data;
}

function probeBytes(fixtureId: string | undefined, imageBase64: string | undefined, demoMode: boolean): Uint8Array {
  if (Boolean(fixtureId) === Boolean(imageBase64)) {
    throw new EideticError("VALIDATION", "Provide exactly one of fixtureId or imageBase64.", 422, false);
  }
  if (fixtureId) {
    if (!demoMode) {
      throw new EideticError("DEMO_FIXTURES_DISABLED", "Synthetic fixture ids are only accepted while DEMO_MODE is on.", 403, false);
    }
    return syntheticFixture(fixtureId);
  }
  const bytes = Buffer.from(imageBase64 ?? "", "base64");
  if (bytes.length === 0 || bytes.length > 512 * 1024) {
    throw new EideticError("CAPTURE_REJECTED", "Image must be between 1 byte and 512KB.", 422, false);
  }
  return bytes;
}
