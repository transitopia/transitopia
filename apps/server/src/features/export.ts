// The registry in its export form (packages/data/src/features.ts): read from the database for the
// public export and the places files, and loaded into a local database by `npm run features -- pull`.

import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import type { Registry } from "@transitopia/data/features.ts";
import { lockRegistry } from "./registry.ts";

const CHUNK = 2000;

/** The whole registry, public parts only (no authors, flags or admin changes). */
export async function registryFromDb(db: Db): Promise<Registry> {
  const versions = await db
    .selectFrom("gtfs_feeds")
    .select([
      "feed_id",
      "version",
      "seq",
      "start_date",
      "end_date",
      "sha256",
      "bytes",
    ])
    .where("reconciled_at", "is not", null)
    .orderBy("seq")
    .execute();
  const features = await db
    .selectFrom("features")
    .select([
      "id",
      "kind",
      "name",
      "parent_id",
      "status",
      "merged_into",
      "operator_id",
      "feed_id",
      sql<number | null>`ST_X(geom::geometry)`.as("lon"),
      sql<number | null>`ST_Y(geom::geometry)`.as("lat"),
    ])
    .orderBy("id")
    .execute();
  const refs = await sql<{
    feature_id: string;
    scheme: string;
    namespace: string;
    ref: string;
    lower: number | null;
    upper: number | null;
  }>`
    select feature_id, scheme, namespace, ref, lower(versions) as lower, upper(versions) as upper
    from feature_refs order by scheme, namespace, ref, lower(versions) nulls first`.execute(
    db,
  );
  return {
    versions: versions.map((v) => ({
      t: "version",
      feed: v.feed_id,
      version: v.version,
      seq: v.seq,
      start: v.start_date,
      end: v.end_date,
      sha256: v.sha256,
      bytes: v.bytes,
    })),
    features: features.map((f) => ({
      t: "feature",
      id: f.id,
      kind: f.kind,
      name: f.name,
      lon: f.lon,
      lat: f.lat,
      parent: f.parent_id,
      status: f.status,
      mergedInto: f.merged_into,
      operator: f.operator_id,
      feed: f.feed_id,
    })),
    refs: refs.rows.map((r) => ({
      t: "ref",
      feature: r.feature_id,
      scheme: r.scheme,
      namespace: r.namespace,
      ref: r.ref,
      from: r.lower,
      to: r.upper,
    })),
  };
}

/**
 * Replace the database's registry with an export: every feature table is cleared, and gtfs_feeds is
 * renumbered to the export's order (versions only here keep theirs after it), so its ranges of refs
 * mean the same versions. Returns how many rows each table lost and got.
 */
export async function loadRegistry(
  db: Db,
  r: Registry,
): Promise<{
  cleared: Record<string, number>;
  features: number;
  refs: number;
}> {
  const result = await db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const cleared: Record<string, number> = {};
    for (const table of [
      "feature_flags",
      "feature_changes",
      "feature_refs",
    ] as const)
      cleared[table] = Number(
        (await tx.deleteFrom(table).executeTakeFirst()).numDeletedRows,
      );
    // One statement: features pointing at each other (parents, merges) go together.
    cleared.features = Number(
      (await tx.deleteFrom("features").executeTakeFirst()).numDeletedRows,
    );

    // gtfs_feeds: the export's versions get its seq; the rest follow, in their order.
    await sql`update gtfs_feeds set seq = -seq, reconciled_at = null`.execute(
      tx,
    );
    for (const v of r.versions) {
      const row = {
        start_date: v.start,
        end_date: v.end,
        sha256: v.sha256,
        bytes: v.bytes,
        seq: v.seq,
        reconciled_at: new Date(),
      };
      await tx
        .insertInto("gtfs_feeds")
        .values({
          feed_id: v.feed,
          version: v.version,
          fetched_at: new Date(),
          object_key: null,
          ...row,
        })
        .onConflict((oc) => oc.columns(["feed_id", "version"]).doUpdateSet(row))
        .execute();
    }
    await sql`
      update gtfs_feeds g set seq = n.seq
      from (select feed_id, version,
                   (select coalesce(max(seq), 0) from gtfs_feeds where seq > 0)
                   + row_number() over (order by fetched_at, start_date, version, feed_id) as seq
            from gtfs_feeds where seq < 0) n
      where g.feed_id = n.feed_id and g.version = n.version`.execute(tx);
    await sql`select setval(pg_get_serial_sequence('gtfs_feeds', 'seq'),
                            coalesce(max(seq), 0) + 1, false) from gtfs_feeds`.execute(
      tx,
    );

    // Features without their links first, then the links (they point at each other).
    for (let i = 0; i < r.features.length; i += CHUNK)
      await tx
        .insertInto("features")
        .values(
          r.features.slice(i, i + CHUNK).map((f) => ({
            id: f.id,
            kind: f.kind,
            name: f.name,
            operator_id: f.operator,
            feed_id: f.feed,
            parent_id: null,
            merged_into: null,
            geom:
              f.lon === null || f.lat === null ?
                null
              : sql`ST_SetSRID(ST_MakePoint(${f.lon}, ${f.lat}), 4326)::geography`,
          })),
        )
        .execute();
    for (const f of r.features)
      if (f.parent || f.mergedInto || f.status !== "active")
        await tx
          .updateTable("features")
          .set({
            parent_id: f.parent,
            merged_into: f.mergedInto,
            status: f.status,
          })
          .where("id", "=", f.id)
          .execute();
    for (let i = 0; i < r.refs.length; i += CHUNK)
      await tx
        .insertInto("feature_refs")
        .values(
          r.refs.slice(i, i + CHUNK).map((x) => ({
            feature_id: x.feature,
            scheme: x.scheme,
            namespace: x.namespace,
            ref: x.ref,
            versions: `[${x.from ?? ""},${x.to ?? ""})`,
            origin: "import" as const,
          })),
        )
        .execute();
    return { cleared, features: r.features.length, refs: r.refs.length };
  });
  // Fresh statistics, or the statistics views plan as if the tables were empty.
  await sql`analyze features, feature_refs, gtfs_feeds`.execute(db);
  return result;
}
