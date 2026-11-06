// The feature/entity ID registry's tables (packages/db/migrations/003_features.sql,
// docs/DESIGN.md#feature-ids): what reconciliation reads (a snapshot of a feed's features
// and refs) and writes (its decisions), lookups by ID or ref, and the admin changes
// (containment, retiring), each recorded in feature_changes.

import { randomFillSync } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import {
  kindOfId,
  mintId,
  nameSuffix,
  parseKey,
  type FeatureKind,
} from "@transitopia/shared/features.ts";
import { FLAG_RESOLUTION } from "@transitopia/shared/admin-api.ts";
import {
  sharedExchangeMerges,
  sharedStopMerges,
  type Decisions,
  type Flag,
  type GtfsFeatureKind,
  type GtfsScheme,
  type ReconcileSettings,
  type RegistryFeature,
  type RegistrySnapshot,
  type SharedExchangeMerge,
  type SharedStop,
  type SharedStopMerge,
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
        // Stops other feeds share with this one (docs/DESIGN.md#shared-stops).
        eb.and([
          eb("kind", "=", "stop"),
          eb(
            "id",
            "in",
            eb
              .selectFrom("feature_refs")
              .select("feature_id")
              .where("namespace", "=", feed)
              .where("scheme", "=", "gtfs-stop"),
          ),
        ]),
      ]),
    )
    .execute();
  // Other feeds' stops a new stop of this one may be.
  const shared = await sharedStops(db, feed);
  const loaded = new Set(rows.map((r) => r.id));
  for (const { row } of shared)
    if (!loaded.has(row.id)) rows.push({ ...row, kind: "stop" as const });
  // A station's feeds: its parent stops' refs, and the stops inside it. A station of standalone
  // rail or ferry stops (West Coast Express) has no ref of its own, and must still be found by name
  // in its feed when their ids change.
  const stationFeeds = new Map<string, string[]>();
  const feedRows = await sql<{ id: string; feed: string }>`
    select r.feature_id as id, r.namespace as feed
    from feature_refs r join features f on f.id = r.feature_id
    where f.kind = 'station' and r.scheme = 'gtfs-stop'
    union
    select s.parent_id, s.feed_id
    from features s join features f on f.id = s.parent_id
    where f.kind = 'station' and s.feed_id is not null`.execute(db);
  for (const r of feedRows.rows) {
    let l = stationFeeds.get(r.id);
    if (!l) stationFeeds.set(r.id, (l = []));
    l.push(r.feed);
  }
  // An exchange's home feed: the one most of its stops are from (by their home feeds), the first
  // by id on a tie. Only it sets the exchange's name and position.
  const exchangeHome = new Map<string, string>();
  const homeRows = await sql<{ id: string; feed: string; n: number }>`
    select s.parent_id as id, s.feed_id as feed, count(*)::int as n
    from features s join features p on p.id = s.parent_id
    where p.kind = 'exchange' and s.status = 'active' and s.feed_id is not null
    group by s.parent_id, s.feed_id
    order by s.parent_id, n desc, s.feed_id`.execute(db);
  for (const r of homeRows.rows)
    if (!exchangeHome.has(r.id)) exchangeHome.set(r.id, r.feed);
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
    ...(r.kind === "exchange" && exchangeHome.has(r.id) ?
      { feedId: exchangeHome.get(r.id)! }
    : {}),
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
    shared: shared.map((x) => x.stop),
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
 * The active stops as shared-stop matching sees them (docs/DESIGN.md#shared-stops), oldest first (by
 * the first feed version of their gtfs-stop refs, which the public export has too, then ID): each with the feeds of its gtfs-stop refs, their operators and its newest code in each. Without
 * the stops that have a gtfs-stop ref in `exceptFeed`.
 */
async function sharedStops(
  db: Db,
  exceptFeed?: string,
): Promise<
  {
    stop: SharedStop;
    row: {
      id: string;
      name: string;
      parent_id: string | null;
      status: "active";
      feed_id: string | null;
      lon: number;
      lat: number;
    };
  }[]
> {
  const rows = await sql<{
    id: string;
    name: string;
    parent_id: string | null;
    feed_id: string | null;
    lon: number;
    lat: number;
    feed: string;
    operator: string;
    code: string | null;
  }>`
    with feeds_of as (
      select distinct feature_id, namespace from feature_refs where scheme = 'gtfs-stop'
    ), first_seen as (
      select feature_id, min(lower(versions)) as seq from feature_refs
      where scheme = 'gtfs-stop' group by feature_id
    ), codes as (
      select distinct on (feature_id, namespace) feature_id, namespace, ref
      from feature_refs where scheme = 'stop'
      order by feature_id, namespace, upper(versions) desc nulls first
    )
    select f.id, f.name, f.parent_id, f.feed_id,
           ST_X(f.geom::geometry) as lon, ST_Y(f.geom::geometry) as lat,
           r.namespace as feed, d.operator_id as operator, c.ref as code
    from features f
    join feeds_of r on r.feature_id = f.id
    join feeds d on d.id = r.namespace
    left join codes c on c.feature_id = f.id and c.namespace = r.namespace
    left join first_seen s on s.feature_id = f.id
    where f.kind = 'stop' and f.status = 'active' and f.geom is not null
      ${
        exceptFeed === undefined ?
          sql``
        : sql`and not exists (select 1 from feeds_of x
                              where x.feature_id = f.id and x.namespace = ${exceptFeed})`
      }
    order by s.seq nulls last, f.id, r.namespace`.execute(db);
  const out = new Map<
    string,
    { stop: SharedStop; row: Awaited<ReturnType<typeof sharedStops>>[0]["row"] }
  >();
  for (const r of rows.rows) {
    let x = out.get(r.id);
    if (!x)
      out.set(
        r.id,
        (x = {
          stop: { id: r.id, name: r.name, lon: r.lon, lat: r.lat, feeds: [] },
          row: {
            id: r.id,
            name: r.name,
            parent_id: r.parent_id,
            status: "active",
            feed_id: r.feed_id,
            lon: r.lon,
            lat: r.lat,
          },
        }),
      );
    x.stop.feeds.push({
      feed: r.feed,
      operator: r.operator,
      ...(r.code !== null ? { code: r.code } : {}),
    });
  }
  return [...out.values()];
}

/**
 * Merge the exchanges minted once per feed that are one exchange (docs/DESIGN.md#shared-stops,
 * `sharedExchangeMerges`): each into the one with the most stops, its stops moving with it, recorded
 * in feature_changes like an admin's merge. In a transaction holding the lock.
 */
export async function mergeSharedExchanges(
  tx: Db,
  settings: Pick<ReconcileSettings, "exchangeMatchM">,
): Promise<SharedExchangeMerge[]> {
  const rows = await sql<{
    id: string;
    name: string;
    lon: number;
    lat: number;
    feeds: string[] | null;
    stops: number;
  }>`
    select e.id, e.name, ST_X(e.geom::geometry) as lon, ST_Y(e.geom::geometry) as lat,
           (select array_agg(distinct r.namespace) from features s
            join feature_refs r on r.feature_id = s.id and r.scheme = 'gtfs-stop'
            where s.parent_id = e.id and s.status = 'active') as feeds,
           (select count(*)::int from features s
            where s.parent_id = e.id and s.status = 'active') as stops
    from features e
    where e.kind = 'exchange' and e.status = 'active' and e.geom is not null`.execute(
    tx,
  );
  const merges = sharedExchangeMerges(
    rows.rows.map((r) => ({ ...r, feeds: r.feeds ?? [] })),
    settings,
  );
  for (const m of merges)
    await mergeInto(tx, m.from, m.into, null, { shared: "exchange", m: m.m });
  return merges;
}

/**
 * Merge the stops that are the same physical stop in several feeds (docs/DESIGN.md#shared-stops)
 * but were minted apart: each into the oldest of its group, recorded in feature_changes like an
 * admin's merge. A pair matched by nearness is flagged (`shared-stop`). The merged stop is in its
 * own station or exchange, else the other's (unless an admin left it in none); where both were in
 * one, different ones, it's flagged `grouping-differs` with the other's as the proposal. In a
 * transaction holding the lock.
 */
export async function mergeSharedStops(
  tx: Db,
  settings: Pick<ReconcileSettings, "sharedStopCodeM" | "sharedStopM">,
): Promise<SharedStopMerge[]> {
  const stops = await sharedStops(tx);
  const merges = sharedStopMerges(
    stops.map((s) => s.stop),
    settings,
  );
  const parentOf = new Map(stops.map((s) => [s.row.id, s.row.parent_id]));
  // Stops whose containment an admin set: theirs to keep, "none" included.
  const adminSet = new Set(
    (
      await tx
        .selectFrom("feature_changes")
        .select("feature_id")
        .distinct()
        .where("action", "=", "set-parent")
        .execute()
    ).map((c) => c.feature_id),
  );
  const flags: Flag[] = [];
  for (const m of merges) {
    await mergeInto(tx, m.from, m.into, null, { shared: m.match, m: m.m });
    if (m.match === "near")
      flags.push({
        featureId: m.into,
        reason: "shared-stop",
        candidates: [m.from],
        detail: { merged: m.from, m: m.m },
      });
    const from = parentOf.get(m.from) ?? null;
    const into = parentOf.get(m.into) ?? null;
    if (from === null || from === into) continue;
    if (into === null && !adminSet.has(m.into)) {
      // One feed puts it in a station or exchange and the other in none: it's in that one.
      await tx
        .updateTable("features")
        .set({ parent_id: from, updated_at: new Date() })
        .where("id", "=", m.into)
        .execute();
      await recordChange(
        tx,
        m.into,
        "set-parent",
        { parent: null },
        { parent: from, merged: m.from },
        null,
      );
      parentOf.set(m.into, from);
      continue;
    }
    flags.push({
      featureId: m.into,
      reason: "grouping-differs",
      candidates: [from],
      detail: { proposed: from, parent: into, merged: m.from },
    });
  }
  await insertFlags(tx, flags);
  return merges;
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

/**
 * One new ID of a kind, checked against the table: for a single feature made by an admin, in the
 * transaction that inserts it (holding the registry lock), so a reconciliation can't take it first.
 */
async function mintOne(
  tx: Db,
  kind: FeatureKind,
  random: (b: Uint8Array) => Uint8Array = (b) => randomFillSync(b),
): Promise<string> {
  for (;;) {
    const id = mintId(kind, random);
    const taken = await tx
      .selectFrom("features")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!taken) return id;
  }
}

export interface ApplyResult {
  minted: number;
  updated: number;
  refsExtended: number;
  refsAdded: number;
  reactivated: number;
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
  if (d.reactivate.length)
    await tx
      .updateTable("features")
      .set({ status: "active", updated_at: new Date() })
      .where("id", "in", d.reactivate)
      .where("status", "=", "retired")
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
  const flagged = await insertFlags(tx, d.flags);
  return {
    minted: d.mint.length,
    updated: d.update.length,
    refsExtended: d.extendRefs.length,
    refsAdded: d.insertRefs.length,
    reactivated: d.reactivate.length,
    flagged,
  };
}

/**
 * Record flags, each feature once for a reason: an admin who resolved it isn't asked again. Returns
 * how many were new.
 */
async function insertFlags(tx: Db, flags: readonly Flag[]): Promise<number> {
  if (!flags.length) return 0;
  let flagged = 0;
  const seen = new Set(
    (
      await tx
        .selectFrom("feature_flags")
        .select(["feature_id", "reason"])
        .where(
          "feature_id",
          "in",
          flags.map((f) => f.featureId),
        )
        .execute()
    ).map((f) => `${f.feature_id} ${f.reason}`),
  );
  for (const f of flags) {
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
  return flagged;
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
      .orderBy(sql`upper(versions)`, (ob) => ob.desc().nullsFirst())
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
    .select([
      "id",
      "kind",
      "name",
      "status",
      "parent_id",
      "feed_id",
      sql<number | null>`ST_X(geom::geometry)`.as("lon"),
      sql<number | null>`ST_Y(geom::geometry)`.as("lat"),
    ])
    .where("parent_id", "=", id)
    .where("status", "!=", "merged")
    .execute();
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status,
      parentId: r.parent_id,
      feedId: r.feed_id,
      lon: r.lon,
      lat: r.lat,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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

/** GET /features/<key> (apps/server/README.md#feature-resolver). */
export interface ResolvedFeature {
  id: string;
  kind: FeatureKind;
  name: string;
  /** The URL name suffix: the canonical key is `${id}-${suffix}`. */
  suffix: string;
  status: "active" | "retired" | "merged";
  operator: string | null;
  feed: string | null;
  parent: string | null;
  centroid: [number, number] | null;
  /** Of the feature and the stops inside it. */
  bbox: [number, number, number, number] | null;
  refs: string[];
  facts: Record<string, never>;
  redirectedFrom?: string;
}

/**
 * Resolve a key: an ID (merged ones redirect) or a ref, the feature it names today, or on a service
 * date (YYYYMMDD; for GTFS refs, in the feed version in use that day: the newest covering it).
 */
export async function resolveKey(
  db: Db,
  key: string,
  date?: string,
): Promise<ResolvedFeature | "unminted" | undefined> {
  const k = parseKey(key);
  if (!k || (k.form === "ref" && k.scheme === "run")) return undefined;
  let found: FeatureRow | undefined;
  if (k.form === "ref" && date) {
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const r = await sql<{ feature_id: string }>`
      select r.feature_id from feature_refs r
      where r.scheme = ${k.scheme} and r.namespace = ${k.namespace} and r.ref = ${k.value}
        and (upper_inf(r.versions) and lower_inf(r.versions)
             or r.versions @> (select g.seq from gtfs_feeds g
                               where g.feed_id = ${k.namespace}
                                 and ${iso}::date between g.start_date and g.end_date
                               order by g.start_date desc, g.version desc limit 1))
      limit 1`.execute(db);
    const id = r.rows[0]?.feature_id;
    found = id ? await findFeature(db, id) : undefined;
  } else found = await findFeature(db, key);
  if (!found)
    return k.form === "ref" && k.scheme.startsWith("osm-") ?
        "unminted"
      : undefined;
  const extent = await sql<{
    xmin: number | null;
    ymin: number | null;
    xmax: number | null;
    ymax: number | null;
  }>`
    select min(ST_X(geom::geometry)) as xmin, min(ST_Y(geom::geometry)) as ymin,
           max(ST_X(geom::geometry)) as xmax, max(ST_Y(geom::geometry)) as ymax
    from features where (id = ${found.id} or parent_id = ${found.id}) and geom is not null`.execute(
    db,
  );
  const e = extent.rows[0];
  // A cycling route's extent is its build's bbox (cycling_routes, cycling-routes.ts), not
  // features.geom, which is null for it (the readers here take geom as a point).
  const route =
    found.kind === "cycling-route" ?
      await sql<{ bbox: [number, number, number, number] }>`
        select c.bbox from cycling_routes c
        join feature_refs r on r.scheme = 'osm-relation' and r.namespace = ''
          and r.ref = c.relation_id::text
        where r.feature_id = ${found.id} and c.bbox is not null
        order by c.area limit 1`
        .execute(db)
        .then((r) => r.rows[0]?.bbox)
    : undefined;
  const refs = await sql<{ scheme: string; namespace: string; ref: string }>`
    select distinct scheme, namespace, ref from feature_refs where feature_id = ${found.id}
    order by scheme, namespace, ref`.execute(db);
  const f = await db
    .selectFrom("features")
    .select(["operator_id"])
    .where("id", "=", found.id)
    .executeTakeFirstOrThrow();
  // The code in its newest version, as the places files name stops (a renumbered stop has several).
  const code = (
    await db
      .selectFrom("feature_refs")
      .select("ref")
      .where("feature_id", "=", found.id)
      .where("scheme", "=", "stop")
      .orderBy(sql`upper(versions)`, (ob) => ob.desc().nullsFirst())
      .executeTakeFirst()
  )?.ref;
  return {
    id: found.id,
    kind: found.kind,
    name: found.name,
    suffix: nameSuffix(found.kind, found.name, { code }),
    status: found.status,
    operator: f.operator_id,
    feed: found.feedId,
    parent: found.parentId,
    centroid:
      route ? [(route[0] + route[2]) / 2, (route[1] + route[3]) / 2]
      : found.lon !== null && found.lat !== null ? [found.lon, found.lat]
      : null,
    bbox:
      route
      ?? (e && e.xmin !== null ? [e.xmin, e.ymin!, e.xmax!, e.ymax!] : null),
    refs: refs.rows.map((r) =>
      r.namespace ?
        `${r.scheme}:${r.namespace}:${r.ref}`
      : `${r.scheme}:${r.ref}`,
    ),
    facts: {},
    ...(found.redirectedFrom ? { redirectedFrom: found.redirectedFrom } : {}),
  };
}

/**
 * Merge a feature into another of the same kind (the same stop under two IDs, a cross-feed
 * station): its refs and the stops inside it move to `intoId`, and its ID redirects there. Merging
 * into a merged feature is refused, so a redirect is always one hop.
 */
export async function mergeFeatures(
  db: Db,
  fromId: string,
  intoId: string,
  userId: number | null = null,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    await mergeInto(tx, fromId, intoId, userId);
  });
}

/** `mergeFeatures` in a transaction holding the lock; `detail` goes in the change's record. */
async function mergeInto(
  tx: Db,
  fromId: string,
  intoId: string,
  userId: number | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const from = await featureById(tx, fromId);
  const into = await featureById(tx, intoId);
  if (!from) throw new Error(`no feature ${fromId}`);
  if (!into) throw new Error(`no feature ${intoId}`);
  if (fromId === intoId) throw new Error("a feature can't merge into itself");
  if (from.kind !== into.kind)
    throw new Error(`${fromId} is a ${from.kind}, ${intoId} a ${into.kind}`);
  if (from.status === "merged") throw new Error(`${fromId} is already merged`);
  if (into.status === "merged")
    throw new Error(
      `${intoId} was merged into ${into.mergedInto}: merge into that`,
    );
  if (into.status === "retired")
    throw new Error(`${intoId} is retired: merge into an active feature`);
  const refs = await tx
    .updateTable("feature_refs")
    .set({ feature_id: intoId })
    .where("feature_id", "=", fromId)
    .executeTakeFirst();
  const children = await tx
    .updateTable("features")
    .set({ parent_id: intoId, updated_at: new Date() })
    .where("parent_id", "=", fromId)
    .executeTakeFirst();
  // Earlier redirects to it now go straight to `intoId`.
  await tx
    .updateTable("features")
    .set({ merged_into: intoId, updated_at: new Date() })
    .where("merged_into", "=", fromId)
    .execute();
  await tx
    .updateTable("features")
    .set({ status: "merged", merged_into: intoId, updated_at: new Date() })
    .where("id", "=", fromId)
    .execute();
  await recordChange(
    tx,
    fromId,
    "merge",
    { status: from.status },
    {
      mergedInto: intoId,
      refs: Number(refs.numUpdatedRows),
      stops: Number(children.numUpdatedRows),
      ...detail,
    },
    userId,
  );
}

/** Make a new exchange of some stops (taken out of whatever they were in). Returns its ID. */
export async function newExchange(
  db: Db,
  name: string,
  stopIds: string[],
  userId: number | null = null,
): Promise<string> {
  if (!name.trim()) throw new Error("an exchange needs a name");
  if (!stopIds.length) throw new Error("an exchange needs stops");
  return db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const id = await mintOne(tx, "exchange");
    const stops: FeatureRow[] = [];
    for (const s of stopIds) {
      const f = await featureById(tx, s);
      if (f?.kind !== "stop" || f.status !== "active")
        throw new Error(`${s} isn't an active stop`);
      stops.push(f);
    }
    const located = stops.filter((s) => s.lon !== null && s.lat !== null);
    const lon = located.reduce((a, s) => a + s.lon!, 0) / located.length;
    const lat = located.reduce((a, s) => a + s.lat!, 0) / located.length;
    await tx
      .insertInto("features")
      .values({
        id,
        kind: "exchange",
        operator_id: null,
        feed_id: null,
        parent_id: null,
        name: name.trim(),
        geom: located.length ? point(lon, lat) : null,
      })
      .execute();
    // Its name was set by an admin: reconciliation keeps it.
    await recordChange(tx, id, "rename", null, { name: name.trim() }, userId);
    for (const s of stops) {
      await tx
        .updateTable("features")
        .set({ parent_id: id, updated_at: new Date() })
        .where("id", "=", s.id)
        .execute();
      await recordChange(
        tx,
        s.id,
        "set-parent",
        { parent: s.parentId },
        { parent: id },
        userId,
      );
    }
    return id;
  });
}

export interface FeatureSummary {
  id: string;
  kind: FeatureKind;
  name: string;
  status: "active" | "retired" | "merged";
  feedId: string | null;
  parentId: string | null;
  lon: number | null;
  lat: number | null;
}

const summaryColumns = [
  "id",
  "kind",
  "name",
  "status",
  "feed_id",
  "parent_id",
  sql<number | null>`ST_X(geom::geometry)`.as("lon"),
  sql<number | null>`ST_Y(geom::geometry)`.as("lat"),
] as const;

const toSummary = (r: {
  id: string;
  kind: FeatureKind;
  name: string;
  status: "active" | "retired" | "merged";
  feed_id: string | null;
  parent_id: string | null;
  lon: number | null;
  lat: number | null;
}): FeatureSummary => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  status: r.status,
  feedId: r.feed_id,
  parentId: r.parent_id,
  lon: r.lon,
  lat: r.lat,
});

/** Features by ID or ref (exact), else by name (places first, at most `limit`). */
export async function searchFeatures(
  db: Db,
  q: string,
  limit = 50,
): Promise<FeatureSummary[]> {
  const text = q.trim();
  if (!text) return [];
  if (parseKey(text)) {
    const f = await findFeature(db, text);
    if (f) {
      const r = await db
        .selectFrom("features")
        .select(summaryColumns)
        .where("id", "=", f.id)
        .execute();
      return r.map(toSummary);
    }
  }
  const rows = await db
    .selectFrom("features")
    .select(summaryColumns)
    .where("name", "ilike", `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .orderBy(
      sql`case kind when 'station' then 0 when 'exchange' then 1 when 'route' then 2 else 3 end`,
    )
    .orderBy("name")
    .limit(limit)
    .execute();
  return rows.map(toSummary);
}

/** A feature with what's around it, for its admin page. */
export async function featureDetail(db: Db, id: string) {
  const f = await db
    .selectFrom("features")
    .select([...summaryColumns, "merged_into", "created_at", "updated_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!f) return undefined;
  const parent =
    f.parent_id ?
      await db
        .selectFrom("features")
        .select(summaryColumns)
        .where("id", "=", f.parent_id)
        .executeTakeFirst()
    : undefined;
  const children = await db
    .selectFrom("features")
    .select(summaryColumns)
    .where("parent_id", "=", id)
    .orderBy("name")
    .execute();
  const flags = await db
    .selectFrom("feature_flags")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("feature_id", "=", id),
        eb(sql<string>`${id}`, "=", eb.fn.any("candidates")),
      ]),
    )
    .orderBy("created_at", "desc")
    .execute();
  const changes = await db
    .selectFrom("feature_changes as c")
    .leftJoin("users as u", "u.id", "c.user_id")
    .select(["c.action", "c.before", "c.after", "c.created_at", "u.login"])
    .where("c.feature_id", "=", id)
    .orderBy("c.id", "desc")
    .execute();
  return {
    feature: { ...toSummary(f), mergedInto: f.merged_into },
    parent: parent ? toSummary(parent) : null,
    // Bays by number: Bay 2 before Bay 10.
    children: children
      .map(toSummary)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    refs: await refsOf(db, id),
    flags: flags.map(flagRow),
    changes: changes.map((c) => ({
      action: c.action,
      before: c.before,
      after: c.after,
      at: c.created_at,
      by: c.login,
    })),
  };
}

const flagRow = (f: {
  id: number;
  feature_id: string;
  candidates: string[];
  reason: string;
  detail: unknown;
  state: "open" | "resolved";
  resolution: string | null;
  created_at: Date;
}) => ({
  id: Number(f.id),
  featureId: f.feature_id,
  candidates: f.candidates,
  reason: f.reason,
  detail: (f.detail ?? null) as Record<string, unknown> | null,
  state: f.state,
  resolution: f.resolution,
  createdAt: f.created_at,
});

/** Open reconciliation flags, oldest first, with their features' names. */
export async function openFlags(db: Db, limit = 200) {
  const rows = await db
    .selectFrom("feature_flags as g")
    .innerJoin("features as f", "f.id", "g.feature_id")
    .selectAll("g")
    .select(["f.name", "f.kind"])
    .where("g.state", "=", "open")
    .orderBy("g.id")
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...flagRow(r), name: r.name, kind: r.kind }));
}

/** Close a flag (FLAG_RESOLUTION: kept, retired, merged:<id> or moved:<id>). */
export async function resolveFlag(
  db: Db,
  flagId: number,
  resolution: string,
  userId: number | null = null,
): Promise<void> {
  if (!FLAG_RESOLUTION.test(resolution))
    throw new Error(`a resolution is kept, retired, merged:<id> or moved:<id>`);
  const r = await db
    .updateTable("feature_flags")
    .set({
      state: "resolved",
      resolution,
      resolved_by: userId,
      resolved_at: new Date(),
    })
    .where("id", "=", flagId)
    .executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw new Error(`no flag ${flagId}`);
}
