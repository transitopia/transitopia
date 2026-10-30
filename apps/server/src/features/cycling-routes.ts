// Bike routes in the database (apps/server/README.md#cycling-routes): the server loads each cycling
// build's routes (var/cycling/<area>/routes.json, packages/cycling-core/README.md#bike-routes) after
// the data build, replacing the area's previous ones, gives them `cr` IDs in the feature registry
// by their ref (`osm-relation:<id>`), and answers a route card's GET /cycling/routes/<key>.

import { randomFillSync } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import { reconcileRoutes } from "@transitopia/cycling-core/reconcile.ts";
import {
  routeTitle,
  type BBox,
  type ComfortLengths,
  type CyclingRoute,
  type CyclingRouteDetail,
  type CyclingRouteLink,
  type CyclingRoutesFile,
} from "@transitopia/cycling-core/routes.ts";
import { nameSuffix } from "@transitopia/shared/features.ts";
import { findFeature, idMinter, lockRegistry } from "./registry.ts";

const CHUNK = 2000;
const SCHEME = "osm-relation";

export interface LoadedRoutes {
  /** False when the database already had this build (the registry is reconciled all the same). */
  loaded: boolean;
  routes: number;
  minted: number;
  renamed: number;
  reactivated: number;
  retired: number;
}

/**
 * Load a build's routes, replacing its area's, and reconcile the registry's cycling routes with
 * every area's (always: `features -- pull` replaces a local registry): in one transaction holding
 * the registry lock.
 */
export async function loadCyclingRoutes(
  db: Db,
  file: CyclingRoutesFile,
  random: (b: Uint8Array) => Uint8Array = (b) => randomFillSync(b),
): Promise<LoadedRoutes> {
  return db.transaction().execute(async (tx) => {
    await lockRegistry(tx);
    const entries = Object.entries(file.routes).map(
      ([id, r]) => [Number(id), r] as const,
    );
    const had = await tx
      .selectFrom("cycling_builds")
      .select("built_at")
      .where("area", "=", file.area)
      .executeTakeFirst();
    const loaded = had?.built_at.getTime() !== new Date(file.builtAt).getTime();
    if (loaded) await replaceBuild(tx, file, entries);
    return {
      loaded,
      routes: entries.length,
      ...(await reconcileRegistry(tx, random)),
    };
  });
}

/** Replace an area's routes with a build's. */
async function replaceBuild(
  tx: Db,
  file: CyclingRoutesFile,
  entries: (readonly [number, CyclingRoute])[],
): Promise<void> {
  // The area's routes and members go with its build (on delete cascade).
  await tx.deleteFrom("cycling_builds").where("area", "=", file.area).execute();
  await tx
    .insertInto("cycling_builds")
    .values({
      area: file.area,
      osm_file: file.osm.file,
      osm_timestamp: file.osm.timestamp,
      built_at: file.builtAt,
    })
    .execute();
  for (let i = 0; i < entries.length; i += CHUNK)
    await tx
      .insertInto("cycling_routes")
      .values(
        entries.slice(i, i + CHUNK).map(([id, r]) => ({
          area: file.area,
          relation_id: id,
          name: r.name ?? null,
          ref: r.ref ?? null,
          network: r.network ?? null,
          length_m: r.lengthM,
          comfort_m: r.comfortM,
          ferry_m: r.ferryM ?? 0,
          bbox: r.bbox ?? null,
        })),
      )
      .execute();
  const members = entries.flatMap(([id, r]) =>
    (r.subroutes ?? []).map((child, position) => ({
      area: file.area,
      parent: id,
      child,
      position,
    })),
  );
  for (let i = 0; i < members.length; i += CHUNK)
    await tx
      .insertInto("cycling_route_members")
      .values(members.slice(i, i + CHUNK))
      .execute();
}

/** The registry's cycling routes matched to every area's (packages/cycling-core/src/reconcile.ts). */
async function reconcileRegistry(
  tx: Db,
  random: (b: Uint8Array) => Uint8Array,
): Promise<Omit<LoadedRoutes, "loaded" | "routes">> {
  const registered = await sql<{
    id: string;
    relation: string;
    name: string;
    status: "active" | "retired";
    renamed: boolean;
  }>`
    select f.id, r.ref as relation, f.name, f.status,
           exists (select 1 from feature_changes c
                   where c.feature_id = f.id and c.action = 'rename') as renamed
    from features f join feature_refs r on r.feature_id = f.id and r.scheme = ${SCHEME}
    where f.kind = 'cycling-route' and f.status <> 'merged'`.execute(tx);
  // A relation in several areas' builds is named by the first area's.
  const present = new Map<number, string>();
  for (const r of await tx
    .selectFrom("cycling_routes")
    .select(["relation_id", "name", "ref"])
    .orderBy("area")
    .execute())
    if (!present.has(r.relation_id)) present.set(r.relation_id, routeTitle(r));
  const d = reconcileRoutes(
    registered.rows.map((r) => ({
      id: r.id,
      relation: Number(r.relation),
      name: r.name,
      status: r.status,
      ...(r.renamed ? { nameLocked: true } : {}),
    })),
    present,
  );
  const mint = await idMinter(tx, random);
  const minted = d.mint.map((m) => ({ ...m, id: mint("cycling-route") }));
  for (let i = 0; i < minted.length; i += CHUNK) {
    const chunk = minted.slice(i, i + CHUNK);
    // geom stays null: a route's extent is its build's bbox (cycling_routes), which changes with
    // each build, and the registry reads geom as a point.
    await tx
      .insertInto("features")
      .values(
        chunk.map((m) => ({ id: m.id, kind: "cycling-route", name: m.name })),
      )
      .execute();
    await tx
      .insertInto("feature_refs")
      .values(
        chunk.map((m) => ({
          feature_id: m.id,
          scheme: SCHEME,
          ref: String(m.relation),
          origin: "reconcile" as const,
        })),
      )
      .execute();
  }
  for (const r of d.rename)
    await tx
      .updateTable("features")
      .set({ name: r.name, updated_at: new Date() })
      .where("id", "=", r.id)
      .execute();
  for (const [ids, status] of [
    [d.reactivate, "active"],
    [d.retire, "retired"],
  ] as const)
    if (ids.length)
      await tx
        .updateTable("features")
        .set({ status, updated_at: new Date() })
        .where("id", "in", ids)
        .execute();
  return {
    minted: minted.length,
    renamed: d.rename.length,
    reactivated: d.reactivate.length,
    retired: d.retire.length,
  };
}

interface RouteRow {
  area: string;
  relation_id: number;
  name: string | null;
  ref: string | null;
  network: string | null;
  length_m: number;
  comfort_m: number[];
  ferry_m: number;
  bbox: number[] | null;
  feature_id: string;
}

/** Routes by relation in an area, with their active features (those without one are left out). */
async function routeRows(
  db: Db,
  area: string,
  relations: readonly number[],
): Promise<Map<number, RouteRow>> {
  if (!relations.length) return new Map();
  const rows = await db
    .selectFrom("cycling_routes as c")
    .innerJoin("feature_refs as r", (j) =>
      j
        .on("r.scheme", "=", SCHEME)
        .on("r.namespace", "=", "")
        .on(sql`r.ref`, "=", sql`c.relation_id::text`),
    )
    .innerJoin("features as f", "f.id", "r.feature_id")
    .select([
      "c.area",
      "c.relation_id",
      "c.name",
      "c.ref",
      "c.network",
      "c.length_m",
      "c.comfort_m",
      "c.ferry_m",
      "c.bbox",
      "f.id as feature_id",
    ])
    .where("c.area", "=", area)
    .where("c.relation_id", "in", [...relations])
    .where("f.status", "=", "active")
    .execute();
  return new Map(rows.map((r) => [r.relation_id, r]));
}

const linkOf = (r: RouteRow): CyclingRouteLink => {
  const name = routeTitle(r);
  return {
    key: `${r.feature_id}-${nameSuffix("cycling-route", name)}`,
    osmRelation: r.relation_id,
    name,
    network: r.network,
  };
};

/** Links to routes, in the order of `relations`. */
async function links(
  db: Db,
  area: string,
  relations: readonly number[],
): Promise<CyclingRouteLink[]> {
  const rows = await routeRows(db, area, relations);
  return relations.flatMap((id) => {
    const r = rows.get(id);
    return r ? [linkOf(r)] : [];
  });
}

/** A route's parents (ascending) or subroutes (in member order). */
async function members(
  db: Db,
  area: string,
  relation: number,
  up: boolean,
): Promise<number[]> {
  const q = db.selectFrom("cycling_route_members").where("area", "=", area);
  return (
    up ?
      await q
        .select("parent as id")
        .where("child", "=", relation)
        .orderBy("parent")
        .execute()
    : await q
        .select("child as id")
        .where("parent", "=", relation)
        .orderBy("position")
        .execute()).map((r) => r.id);
}

/**
 * A route card's data, by `cr` ID (its name suffix ignored) or `osm-relation:` ref: undefined for
 * anything else, and for a route that's retired or in no build.
 */
export async function cyclingRouteDetail(
  db: Db,
  key: string,
): Promise<CyclingRouteDetail | undefined> {
  const f = await findFeature(db, key);
  if (f?.kind !== "cycling-route" || f.status !== "active") return undefined;
  const ref = await db
    .selectFrom("feature_refs")
    .select("ref")
    .where("feature_id", "=", f.id)
    .where("scheme", "=", SCHEME)
    .executeTakeFirst();
  if (!ref) return undefined;
  const relation = Number(ref.ref);
  const at = await db
    .selectFrom("cycling_routes as c")
    .innerJoin("cycling_builds as b", "b.area", "c.area")
    .select(["c.area", "b.built_at"])
    .where("c.relation_id", "=", relation)
    .orderBy("c.area")
    .executeTakeFirst();
  if (!at) return undefined;
  const route = (await routeRows(db, at.area, [relation])).get(relation);
  if (!route) return undefined;
  const parents = await members(db, at.area, relation, true);
  // Every route above it, nearest first, each once (OSM's nesting can loop).
  const ancestors: number[] = [];
  const seen = new Set([relation]);
  for (let level = parents; level.length;) {
    const next: number[] = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      ancestors.push(p);
      next.push(...(await members(db, at.area, p, true)));
    }
    level = next;
  }
  return {
    ...linkOf(route),
    ref: route.ref,
    bbox: route.bbox as BBox | null,
    lengthM: route.length_m,
    comfortM: route.comfort_m as ComfortLengths,
    ferryM: route.ferry_m,
    parents: await links(db, at.area, parents),
    ancestors: await links(db, at.area, ancestors),
    subroutes: await links(
      db,
      at.area,
      await members(db, at.area, relation, false),
    ),
    builtAt: at.built_at.toISOString(),
  };
}
