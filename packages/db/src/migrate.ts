// Applies packages/db/migrations/NNN_*.sql in order, each in its own transaction, recording them in
// schema_migrations. Safe to run from several processes at once (an advisory lock serialises them)
// and on every server start: applied migrations are skipped. Migrations are never edited once
// deployed; add a new one instead.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
/** pg_advisory_lock key for migrations ("tmig"). */
const LOCK_KEY = 0x746d6967;

export async function migrate(
  pool: pg.Pool,
  log: (msg: string) => void = () => {},
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(dir))
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (
        await client.query<{ name: string }>(
          "select name from schema_migrations",
        )
      ).rows.map((r) => r.name),
    );
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [
          f,
        ]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`, {
          cause: e,
        });
      }
      applied.push(f);
      log(`applied migration ${f}`);
    }
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [LOCK_KEY])
      .catch(() => {});
    client.release();
  }
  return applied;
}
