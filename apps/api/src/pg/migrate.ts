// © Infinitum Corporation®. All rights reserved.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool, directory: string): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [file]);
    if (existing.rowCount) continue;
    const sql = readFileSync(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
