// A Kysely instance on a pg pool. DATABASE_URL is e.g. postgres://transitopia:…@db:5432/transitopia.

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

// Service dates stay "YYYY-MM-DD" (pg would make them local-midnight Dates), and bigints become
// numbers (ids and counts here stay far below 2^53).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
type TypeId = Parameters<typeof pg.types.setTypeParser>[0];
const DATE_ARRAY = 1182 as TypeId;
const TEXT_ARRAY = 1009 as TypeId;
pg.types.setTypeParser(DATE_ARRAY, pg.types.getTypeParser(TEXT_ARRAY));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = Kysely<Database>;

export function createPool(url: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max });
  // An idle client losing its connection (e.g. a database restart) must not crash the server.
  pool.on("error", (e) => console.error("[db] idle client error:", e.message));
  return pool;
}

export function createDb(url: string, max = 10): { db: Db; pool: pg.Pool } {
  const pool = createPool(url, max);
  return {
    db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    pool,
  };
}
