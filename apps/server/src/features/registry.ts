// The feature registry's tables (packages/db/migrations/003_features.sql, docs/DESIGN.md#feature-ids):
// what reconciliation reads (a snapshot of a feed's features and refs) and writes (its decisions),
// lookups by ID or ref, and the admin changes (containment, retiring), each recorded in
// feature_changes.

import { randomFillSync } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import {
  kindOfId,
  mintId,
  parseKey,
  type FeatureKind,
} from "@transitopia/shared/features.ts";
import type {
  Decisions,
  GtfsFeatureKind,
  GtfsScheme,
  RegistryFeature,
  RegistrySnapshot,
} from "@transitopia/transit-core/features/reconcile.ts";

/** A connection or a transaction (a Transaction is a Kysely). */
type Tx = Db;

const CHUNK = 2000;
const GTFS_SCHEMES: GtfsScheme[] = ["gtfs-stop", "gtfs-route", "stop"];
/** pg_advisory_xact_lock key for registry writes ("feat"). */
const LOCK_KEY = 0x66656174;

/** Serialise registry writes (the server's reconciliation and the features CLI) within a transaction. */
export async function lockRegistry(tx: Db): Promise<void> {
  await sql`select pg_advisory_xact_lock(${LOCK_KEY})`.execute(tx);
}

const point = (lon: number | null, lat: number | null) =>
  lon === null || lat === null ?
    null
  : sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;

/** What reconciling a version of `feed` needs to know of the registry. */
export async function loadSnapshot(
  db: Db,
  feed: string,
): Promise<RegistrySnapshot> {
  const rows = await db
    .selectFrom("features")
    .select([
      "id",
      "kind",
      "name",
      "parent_id",
      "status",
      "feed_id",
      sql<number | null>`ST_X(geom::geometry)`.as("lon"),
      sql<number | null>`ST_Y(geom::geometry)`.as("lat"),
    ])
    .where((eb) =>
      eb.or([
        eb.and([eb("feed_id", "=", feed), eb("kind", "in", ["stop", "route"])]),
        eb("kind", "in", ["station", "exchange"]),
      ]),
    )
    .execute();
  const stationFeeds = new Map<string, string[]>();
  for (const r of await db
    .selectFrom("feature_refs as r")
    .innerJoin("features as f", "f.id", "r.feature_id")
    .select(["r.feature_id", "r.namespace"])
    .distinct()
    .where("f.kind", "=", "station")
    .where("r.scheme", "=", "gtfs-stop")
    .execute()) {
    let l = stationFeeds.get(r.feature_id);
    if (!l) stationFeeds.set(r.feature_id, (l = []));
    l.push(r.namespace);
  }
  const locked = new Map<string, Set<string>>();
  for (const c of await db
    .selectFrom("feature_changes")
    .select(["feature_id", "action"])
    .distinct()
    .where("action", "in", ["rename", "set-position"])
    .execute()) {
    let s = locked.get(c.feature_id);
    if (!s) locked.set(c.feature_id, (s = new Set()));
    s.add(c.action);
  }
  const features: RegistryFeature[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind as GtfsFeatureKind,
    name: r.name,
    status: r.status,
    ...(r.lon !== null && r.lat !== null ? { lon: r.lon, lat: r.lat } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.feed_id ? { feedId: r.feed_id } : {}),
    ...(r.kind === "station" ? { feeds: stationFeeds.get(r.id) ?? [] } : {}),
    ...(locked.get(r.id)?.has("rename") ? { nameLocked: true } : {}),
    ...(locked.get(r.id)?.has("set-position") ? { geomLocked: true } : {}),
  }));
  // Each ref's newest range.
  const refs = await sql<{
    id: number;
    feature_id: string;
    scheme: GtfsScheme;
    ref: string;
    lower: number;
    upper: number;
  }>`
    select distinct on (scheme, ref) id, feature_id, scheme, ref,
           lower(versions) as lower, upper(versions) as upper
    from feature_refs
    where namespace = ${feed} and scheme in (${sql.join(GTFS_SCHEMES)})
    order by scheme, ref, upper(versions) desc`.execute(db);
  return {
    features,
    refs: refs.rows.map((r) => ({
      rowId: Number(r.id),
      featureId: r.feature_id,
      scheme: r.scheme,
      value: r.ref,
      lower: r.lower,
      upper: r.upper,
    })),
  };
}

/**
 * A minter of IDs no feature has: `random` fills bytes (crypto random bytes in production),
 * and a clash with an existing ID draws again.
 */
export async function idMinter(
  db: Db,
  random: (b: Uint8Array) => Uint8Array = (b) => randomFillSync(b),
): Promise<(kind: FeatureKind) => string> {
  const taken = new Set(
    (await db.selectFrom("features").select("id").execute()).map((r) => r.id),
  );
  return (kind) => {
    let id: string;
    do id = mintId(kind, random);
    while (taken.has(id));
    taken.add(id);
    return id;
  };
}

export interface ApplyResult {
  minted: number;
  updated: number;
  refsExtended: number;
  refsAdded: number;
  flagged: number;
}

/** Write reconciliation's decisions for a version of `feed`. In a transaction holding the lock. */
export async function applyDecisions(
  tx: Db,
  feed: string,
  d: Decisions,
): Promise<ApplyResult> {
  for (let i = 0; i < d.mint.length; i += CHUNK)
    await tx
      .insertInto("features")
      .values(
        d.mint.slice(i, i + CHUNK).map((m) => {
          if (kindOfId(m.id) !== m.kind)
            throw new Error(`${m.id} isn't an ID of a ${m.kind}`);
          return {
            id: m.id,
            kind: m.kind,
            operator_id: m.operatorId,
            feed_id: m.feedId,
            parent_id: m.parentId,
            name: m.name,
            geom: point(m.lon, m.lat),
          };
        }),
      )
      .execute();
  for (const u of d.update)
    await tx
      .updateTable("features")
      .set({
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.lon !== undefined && u.lat !== undefined ?
          { geom: point(u.lon, u.lat) }
        : {}),
        updated_at: new Date(),
      })
      .where("id", "=", u.id)
      .execute();
  // Every range carried on gets the same new upper bound.
  const byUpper = new Map<number, number[]>();
  for (const e of d.extendRefs) {
    let l = byUpper.get(e.upper);
    if (!l) byUpper.set(e.upper, (l = []));
    l.push(e.rowId);
  }
  for (const [upper, ids] of byUpper)
    for (let i = 0; i < ids.length; i += CHUNK)
      await tx
        .updateTable("feature_refs")
        .set({ versions: sql<string>`int4range(lower(versions), ${upper})` })
        .where("id", "in", ids.slice(i, i + CHUNK))
        .execute();
  for (let i = 0; i < d.insertRefs.length; i += CHUNK)
    await tx
      .insertInto("feature_refs")
      .values(
        d.insertRefs.slice(i, i + CHUNK).map((r) => ({
          feature_id: r.featureId,
          scheme: r.scheme,
          namespace: feed,
          ref: r.value,
          versions: `[${r.lower},${r.upper})`,
          origin: "reconcile" as const,
        })),
      )
      .execute();
  // A feature is flagged once for a reason: an admin who resolved it isn't asked again.
  let flagged = 0;
  if (d.flags.length) {
    const seen = new Set(
      (
        await tx
          .selectFrom("feature_flags")
          .select(["feature_id", "reason"])
          .where(
            "feature_id",
            "in",
            d.flags.map((f) => f.featureId),
          )
          .execute()
      ).map((f) => `${f.feature_id} ${f.reason}`),
    );
    for (const f of d.flags) {
      const k = `${f.featureId} ${f.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await tx
        .insertInto("feature_flags")
        .values({
          feature_id: f.featureId,
          reason: f.reason,
          candidates: f.candidates,
          detail: JSON.stringify(f.detail),
        })
        .execute();
      flagged++;
    }
  }
  return {
    minted: d.mint.length,
    updated: d.update.length,
    refsExtended: d.extendRefs.length,
    refsAdded: d.insertRefs.length,
    flagged,
  };
}

export interface FeatureRow {
  id: string;
  kind: FeatureKind;
  name: string;
  status: "active" | "retired" | "merged";
  parentId: string | null;
  feedId: string | null;
  lon: number | null;
  lat: number | null;
  /** Set when the key named a feature merged into this one. */
  redirectedFrom?: string;
}

const withoutMerge = ({
  mergedInto,
  ...row
}: FeatureRow & { mergedInto: string | null }): FeatureRow => row;

async function featureById(
  db: Tx,
  id: string,
): Promise<(FeatureRow & { mergedInto: string | null }) | undefined> {
  const r = await db
    .selectFrom("features")
    .select([
      "id",
      "kind",
      "name",
      "status",
      "parent_id",
      "feed_id",
      "merged_into",
      sql<number | null>`ST_X(geom::geometry)`.as("lon"),
      sql<number | null>`ST_Y(geom::geometry)`.as("lat"),
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  return (
    r && {
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status,
      parentId: r.parent_id,
      feedId: r.feed_id,
      lon: r.lon,
      lat: r.lat,
      mergedInto: r.merged_into,
    }
  );
}

/**
 * The feature a key names: an ID (its name suffix ignored; a merged feature's ID redirects, one hop)
 * or a ref (the feature it names in its newest version).
 */
export async function findFeature(
  db: Tx,
  key: string,
): Promise<FeatureRow | undefined> {
  const k = parseKey(key);
  if (!k) return undefined;
  let id: string | undefined;
  if (k.form === "id") id = k.id;
  else {
    const r = await db
      .selectFrom("feature_refs")
      .select("feature_id")
      .where("scheme", "=", k.scheme)
      .where("namespace", "=", k.namespace)
      .where("ref", "=", k.value)
      .orderBy(sql`upper(versions)`, sql`desc nulls first`)
      .executeTakeFirst();
    id = r?.feature_id;
  }
  if (!id) return undefined;
  const f = await featureById(db, id);
  if (!f) return undefined;
  if (!f.mergedInto) return withoutMerge(f);
  const to = await featureById(db, f.mergedInto);
  return to && { ...withoutMerge(to), redirectedFrom: key };
}

/** A feature's refs, with the feed versions each range covers. */
export async function refsOf(
  db: Db,
  id: string,
): Promise<{ ref: string; versions: string[] }[]> {
  const rows = await sql<{
    scheme: string;
    namespace: string;
    ref: string;
    lower: number | null;
    upper: number | null;
    first: string | null;
    last: string | null;
  }>`
    select r.scheme, r.namespace, r.ref, lower(r.versions) as lower, upper(r.versions) as upper,
           (select version from gtfs_feeds where seq = lower(r.versions)) as first,
           (select version from gtfs_feeds g where g.feed_id = r.namespace
              and g.seq < upper(r.versions) order by g.seq desc limit 1) as last
    from feature_refs r where r.feature_id = ${id}
    order by r.scheme, r.ref, lower(r.versions)`.execute(db);
  return rows.rows.map((r) => ({
    ref:
      r.namespace ?
        `${r.scheme}:${r.namespace}:${r.ref}`
      : `${r.scheme}:${r.ref}`,
    versions:
      r.lower === null ?
        []
      : [r.first ?? String(r.lower), r.last ?? String(r.upper)],
  }));
}

/** The stops inside a station or exchange. */
export async function childrenOf(db: Tx, id: string): Promise<FeatureRow[]> {
  const rows = await db
    .selectFrom("features")
    .select("id")
    .where("parent_id", "=", id)
    .where("status", "!=", "merged")
    .orderBy("name")
    .execute();
  const out: FeatureRow[] = [];
  for (const r of rows) {
    const f = await featureById(db, r.id);
    if (f) out.push(withoutMerge(f));
  }
  return out;
}

async function recordChange(
  tx: Tx,
  featureId: string,
  action: string,
  before: unknown,
  after: unknown,
  userId: number | null,
): Promise<void> {
  await tx
    .insertInto("feature_changes")
    .values({
      feature_id: featureId,
      action,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
      user_id: userId,
    })
    .execute();
}

/**
 * Put a stop in a station or exchange, or (parent null) in none. Later builds keep it there
 * (docs/DESIGN.md#relationships-between-features).
 */
export async function setParent(
  db: Db,
  stopId: string,
  parentId: string | null,
  userId: number | null = null,
): Promise<{ before: string | null; after: string | null }> {
  return db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const stop = await featureById(tx, stopId);
    if (!stop) throw new Error(`no feature ${stopId}`);
    if (stop.kind !== "stop")
      throw new Error(`${stopId} is a ${stop.kind}, not a stop`);
    if (stop.status !== "active")
      throw new Error(`${stopId} is ${stop.status}`);
    if (parentId !== null) {
      const p = await featureById(tx, parentId);
      if (!p) throw new Error(`no feature ${parentId}`);
      if (p.kind !== "station" && p.kind !== "exchange")
        throw new Error(
          `${parentId} is a ${p.kind}: a stop's parent is a station or exchange`,
        );
      if (p.status !== "active") throw new Error(`${parentId} is ${p.status}`);
    }
    if (stop.parentId === parentId)
      return { before: parentId, after: parentId };
    await tx
      .updateTable("features")
      .set({ parent_id: parentId, updated_at: new Date() })
      .where("id", "=", stopId)
      .execute();
    await recordChange(
      tx,
      stopId,
      "set-parent",
      { parent: stop.parentId },
      { parent: parentId },
      userId,
    );
    return { before: stop.parentId, after: parentId };
  });
}

/**
 * Retire a feature (a removed stop, an exchange that isn't one). It keeps its refs, so old links and
 * statistics still find it. A station or exchange must be empty first (setParent its stops).
 */
export async function retire(
  db: Db,
  id: string,
  userId: number | null = null,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const f = await featureById(tx, id);
    if (!f) throw new Error(`no feature ${id}`);
    if (f.status !== "active") throw new Error(`${id} is already ${f.status}`);
    const inside = (await childrenOf(tx, id)).filter(
      (c) => c.status === "active",
    );
    if (inside.length)
      throw new Error(
        `${id} (${f.name}) still has ${inside.length} stops: detach or move them first (${inside.map((c) => c.id).join(", ")})`,
      );
    await tx
      .updateTable("features")
      .set({ status: "retired", updated_at: new Date() })
      .where("id", "=", id)
      .execute();
    await recordChange(
      tx,
      id,
      "retire",
      { status: f.status },
      { status: "retired" },
      userId,
    );
  });
}
