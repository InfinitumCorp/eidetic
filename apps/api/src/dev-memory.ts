// © Infinitum Corporation®. All rights reserved.

// pnpm dev:memory
// The API with in-memory stores and the mock matcher, for trying the desks without PostgreSQL.
// Local development only: it accepts the seeded dev-* bearer tokens, keeps nothing on disk, and refuses
// to start when NODE_ENV=production or DEMO_MODE=false. Everything is gone when the process exits.

import { serve } from "@hono/node-server";
import { sha256Hex } from "@eidetic/contracts";
import { createMemoryRuntime, seedReferenceData, seedSyntheticQueue } from "@eidetic/pipeline";
import { createApp } from "./app.js";
import { readSearchLimit } from "./env.js";

if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE === "false") {
  console.error("dev:memory is a local development server. It is refused when NODE_ENV=production or DEMO_MODE=false.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 43110);
const runtime = createMemoryRuntime({ now: () => new Date(), searchLimitPerHour: readSearchLimit(process.env.SEARCH_LIMIT_PER_HOUR) });
await seedReferenceData(runtime.repos, { demoMode: true });

if (process.argv.includes("--seed")) {
  const admin = await runtime.repos.actors.get("actor-admin");
  const operator = await runtime.repos.actors.get("actor-operator");
  if (admin && operator) await seedSyntheticQueue(runtime.service, { admin, operator });
}

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
  adapters: { store: "memory (dev only)", policy: "embedded-rego", identity: "dev-bearer (local only)" },
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(
    JSON.stringify({
      level: "warn",
      msg: "In-memory dev API. Dev bearer tokens only. Nothing is persisted.",
      port: info.port,
      tokens: ["dev-admin", "dev-operator", "dev-reviewer", "dev-auditor"],
    }),
  );
});
