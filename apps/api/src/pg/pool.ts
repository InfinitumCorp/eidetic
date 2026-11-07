// © Infinitum Corporation®. All rights reserved.

import pg, { type Pool, type PoolClient } from "pg";

pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export type Sql = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export function asSql(source: Pool | PoolClient): Sql {
  return {
    async query(text, params) {
      const result = await source.query(text, (params ?? []) as never[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
  };
}
