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

/** The UTC day an instant falls on. */
const utcDate = (t: number) =>
  Temporal.Instant.fromEpochMilliseconds(t)
    .toZonedDateTimeISO("UTC")
    .toPlainDate();

/** Create daily partitions for [from − 1 day, from + daysAhead] and monthly ones for this month and the next. */
export async function ensurePartitions(
  db: Db,
  now = Date.now(),
  daysAhead = 3,
): Promise<void> {
  const today = utcDate(now);
  for (const table of DAILY_TABLES)
    for (let d = -1; d <= daysAhead; d++) {
      const from = today.add({ days: d });
      const name = `${table}_${from.toString().replaceAll("-", "")}`;
      await sql`create table if not exists ${sql.id(name)} partition of ${sql.id(table)}
        for values from (${sql.lit(from.toString())}) to (${sql.lit(from.add({ days: 1 }).toString())})`.execute(
        db,
      );
    }
  const month = today.toPlainYearMonth();
  for (const table of MONTHLY_TABLES)
    for (let m = -1; m <= 1; m++) {
      const start = month.add({ months: m });
      const end = start.add({ months: 1 });
      const name = `${table}_${start.toString().replace("-", "")}`;
      await sql`create table if not exists ${sql.id(name)} partition of ${sql.id(table)}
        for values from (${sql.lit(start.toPlainDate({ day: 1 }).toString())}) to (${sql.lit(end.toPlainDate({ day: 1 }).toString())})`.execute(
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
  const last = utcDate(to);
  for (
    let d = utcDate(from);
    Temporal.PlainDate.compare(d, last) <= 0;
    d = d.add({ days: 1 })
  )
    await ensurePartitions(db, d.toZonedDateTime("UTC").epochMilliseconds, 0);
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
      const day = /_(\d{8})$/.exec(name)?.[1];
      if (!day) continue;
      const end = Temporal.PlainDate.from(day)
        .add({ days: 1 })
        .toZonedDateTime("UTC").epochMilliseconds;
      if (end > cutoff) continue;
      await sql`drop table ${sql.id(name)}`.execute(db);
      dropped.push(name);
    }
  }
  return dropped;
}
