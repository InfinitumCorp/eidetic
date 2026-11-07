// © Infinitum Corporation®. All rights reserved.

import { readFileSync, writeFileSync } from "node:fs";
import { verifyExportDocument } from "@eidetic/audit";
import { readEnv } from "./env.js";
import { migrate } from "./pg/migrate.js";
import { asSql, createPool } from "./pg/pool.js";
import { createRepositories } from "./pg/stores.js";
import { resolveAuditSigner } from "./startup.js";

const args = process.argv.slice(2);
const command = args[0];
const fileAt = args.indexOf("--file");
const outAt = args.indexOf("--out");
const env = readEnv();

if (command === "verify" && fileAt >= 0) {
  const document = JSON.parse(readFileSync(args[fileAt + 1] ?? "", "utf8")) as unknown;
  const result = verifyExportDocument(document);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const pool = createPool(env.databaseUrl);
await migrate(pool, env.migrationsDir);
const repos = createRepositories(asSql(pool), resolveAuditSigner(env));

if (command === "export") {
  const payload = await repos.audit.export();
  const target = outAt >= 0 ? (args[outAt + 1] ?? "audit-export.json") : "audit-export.json";
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, entries: payload.entries.length, out: target }));
  await pool.end();
  process.exit(0);
}

if (command === "verify") {
  if (args.includes("--sign-legacy")) {
    const signed = await repos.audit.signLegacy();
    console.log(JSON.stringify({ signedLegacyCheckpoints: signed }));
  }
  const result = await repos.audit.verify();
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
  process.exit(result.ok ? 0 : 1);
}

console.error("Usage: audit-cli.ts verify [--file export.json] | export [--out file.json]");
await pool.end();
process.exit(2);
