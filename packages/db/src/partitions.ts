// Partitions for the tables that grow with every poll (migrations/001_initial.sql): daily (UTC) for
// raw data, which expires after the retention period by dropping whole partitions, and monthly for
// observed stop times, which are kept. Partition bounds are literals (DDL takes no parameters). The server creates partitions a few days ahead and drops
// expired ones daily.

import { sql } from "kysely";
import type { Db } from "./connect.ts";

/** Raw tables partitioned by UTC day on a timestamptz column. */
export const DAILY_TABLES = ["rt_positions", "ais_fixes"] as const;
/** Tables partitioned by month on service_date. */
export const MONTHLY_TABLES = ["observed_stop_times"] as const;

const DAY_MS = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Create daily partitions for [from − 1 day, from + daysAhead] and monthly ones for this month and the next. */
export async function ensurePartitions(
  db: Db,
  now = Date.now(),
  daysAhead = 3,
): Promise<void> {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  for (const table of DAILY_TABLES)
    for (let d = -1; d <= daysAhead; d++) {
      const from = today + d * DAY_MS;
      const name = `${table}_${ymd(from).replaceAll("-", "")}`;
      await sql`create table if not exists ${sql.id(name)} partition of ${sql.id(table)}
        for values from (${sql.lit(ymd(from))}) to (${sql.lit(ymd(from + DAY_MS))})`.execute(
        db,
      );
    }
  const month = new Date(now);
  for (const table of MONTHLY_TABLES)
    for (let m = -1; m <= 1; m++) {
      const start = new Date(
        Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + m, 1),
      );
      const end = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
      );
      const name = `${table}_${ymd(start.getTime()).slice(0, 7).replace("-", "")}`;
      await sql`create table if not exists ${sql.id(name)} partition of ${sql.id(table)}
        for values from (${sql.lit(ymd(start.getTime()))}) to (${sql.lit(ymd(end.getTime()))})`.execute(
        db,
      );
    }
}

/** Create the partitions [from, to] needs (importing older history). */
export async function ensurePartitionsFor(
  db: Db,
  from: number,
  to: number,
): Promise<void> {
  for (let t = Math.floor(from / DAY_MS) * DAY_MS; t <= to; t += DAY_MS)
    await ensurePartitions(db, t, 0);
}

/** Drop daily partitions that end before `cutoff`. Returns the dropped names. */
export async function dropExpiredPartitions(
  db: Db,
  cutoff: number,
): Promise<string[]> {
  const dropped: string[] = [];
  for (const table of DAILY_TABLES) {
    const { rows } = await sql<{ name: string }>`
      select c.relname as name from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      where p.relname = ${table}`.execute(db);
    for (const { name } of rows) {
      const m = /_(\d{4})(\d{2})(\d{2})$/.exec(name);
      if (!m) continue;
      const end =
        Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS;
      if (end > cutoff) continue;
      await sql`drop table ${sql.id(name)}`.execute(db);
      dropped.push(name);
    }
  }
  return dropped;
}
