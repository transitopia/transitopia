// Disk used by the database, per table with partitions summed into their parent, so the sizing in
// deployment/README.md#sizing can be checked against production (/admin/api/status → storage).

import { sql } from "kysely";
import type { Db } from "./connect.ts";

export interface TableSize {
  table: string;
  /** Table, indexes and TOAST, in bytes. */
  bytes: number;
  /** Planner estimate (pg_class.reltuples), not an exact count. */
  rows: number;
  /** Partitions (0 for an unpartitioned table). */
  partitions: number;
}

export async function storageSizes(
  db: Db,
): Promise<{ databaseBytes: number; tables: TableSize[] }> {
  const [{ bytes }] = (
    await sql<{
      bytes: string;
    }>`select pg_database_size(current_database()) as bytes`.execute(db)
  ).rows as [{ bytes: string }];
  const tables = await sql<{
    table: string;
    bytes: string;
    rows: string;
    partitions: string;
  }>`
    select coalesce(parent.relname, c.relname) as table,
           sum(pg_total_relation_size(c.oid)) as bytes,
           sum(greatest(c.reltuples, 0))::bigint as rows,
           count(parent.oid) as partitions
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_inherits i on i.inhrelid = c.oid
    left join pg_class parent on parent.oid = i.inhparent
    where n.nspname = 'public' and c.relkind = 'r'
    group by 1
    order by 2 desc`.execute(db);
  return {
    databaseBytes: Number(bytes),
    tables: tables.rows.map((r) => ({
      table: r.table,
      bytes: Number(r.bytes),
      rows: Number(r.rows),
      partitions: Number(r.partitions),
    })),
  };
}
