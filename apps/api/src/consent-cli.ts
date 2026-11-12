// © Infinitum Corporation®. All rights reserved.

// pnpm consent:sweep
// Purges the sealed template of every subject whose consent grants have all lapsed or been withdrawn.
// Each purge is written to the audit log. Safe to run on a schedule: a second run finds nothing to do.

import type { Actor } from "@eidetic/contracts";
import { readEnv } from "./env.js";
import { createPgRuntime } from "./runtime.js";

/** The audit log names this process as the actor, so a scheduled sweep is distinguishable from a person. */
export const SWEEP_ACTOR: Actor = { id: "system:consent-sweep", displayName: "Scheduled consent sweep", role: "admin" };

const runtime = await createPgRuntime(readEnv());
try {
  const result = await runtime.service.sweepLapsedConsent(SWEEP_ACTOR);
  console.log(JSON.stringify({ ok: true, checkedAt: result.checkedAt, purged: result.purged.length, cids: result.purged.map((item) => item.cid) }));
} finally {
  await runtime.pool.end();
}
