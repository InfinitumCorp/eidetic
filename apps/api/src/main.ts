// © Infinitum Corporation®. All rights reserved.

import { serve } from "@hono/node-server";
import { COMPANY, MIL_PRODUCT, PRODUCT } from "@eidetic/contracts";
import { createApp } from "./app.js";
import { conjureRoutesFromEnv } from "./conjure/conjure.mjs";
import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";
import { searchRoutesFromEnv } from "./search/search.mjs";
import { readEnv } from "./env.js";
import { createPool } from "./pg/pool.js";
import { createPgRuntime, waitForDatabase } from "./runtime.js";

const env = readEnv();
const pool = createPool(env.databaseUrl);
await waitForDatabase(pool);
const runtime = await createPgRuntime(env, pool);
if (env.demoMode) {
  console.log(JSON.stringify({ level: "warn", msg: "DEMO_MODE is on. Dev bearer tokens are seeded. Do not expose this process." }));
}
if (env.presidioUrl) {
  console.log(JSON.stringify({ level: "info", msg: "PRESIDIO_URL is set. This build still redacts with the local pattern redactor and does not proxy note text." }));
}

const app = createApp({
  service: runtime.service,
  repos: runtime.repos,
  authenticate: runtime.authenticate,
  demoMode: env.demoMode,
  matcherMode: env.matcherMode,
  milEnabled: env.milEnabled,
  conjure: env.milEnabled ? null : conjureRoutesFromEnv(process.env, { prefix: "/v1/conjure", source: "eidetic" }),
  openclaw: env.milEnabled ? null : openClawRoutesFromEnv(process.env, { prefix: "/v1/openclaw", product: "eidetic" }),
  search: env.milEnabled ? null : searchRoutesFromEnv(process.env, { prefix: "/v1/search" }),
  dbPing: async () => {
    try {
      await pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  },
  adapters: {
    policy: env.opaUrl ? "opa" : "embedded-rego",
    identity: `cumulus-id ${env.cid.issuers.join(" ")}${env.devBearer ? " + dev-bearer (local only)" : ""}${env.keycloakIssuer ? " + keycloak machines" : ""}`,
    consentExport: env.fidesUrl ? "fides" : "local",
    redaction: "local-pattern",
    presidio: env.presidioUrl ? "configured-not-proxied" : "not_configured",
    fairness: "local-typescript",
    fairlearn: "not_invoked",
    audit: env.auditSigner === "openbao" ? "ed25519-openbao-transit" : "ed25519-env",
    trillian: "not_configured",
    verifiableCredential: "local-sha256-consent-receipt",
    eidt: "stub-no-broadcast",
    rasterio: "not_enabled",
    insightface: env.matcherMode === "insightface" ? "sidecar" : "not_selected",
    opencvZoo: env.matcherMode === "opencv-zoo" ? "yunet-sface" : "not_selected",
    captureQuality: env.captureProvider,
  },
});

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(JSON.stringify({ level: "info", product: PRODUCT, company: COMPANY, mil: MIL_PRODUCT, port: info.port }));
});
