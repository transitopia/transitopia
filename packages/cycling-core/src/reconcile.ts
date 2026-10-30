// Feature IDs for bike routes (packages/cycling-core/README.md#bike-routes): the registry's
// cycling-route features matched to a build's routes by their ref (`osm-relation:<id>`), which holds
// for good. Pure: the server reads the registry and writes the decisions (apps/server/src/features/cycling-routes.ts).

/** A cycling-route feature in the registry, with its relation. */
export interface RegisteredRoute {
  id: string;
  relation: number;
  name: string;
  status: "active" | "retired";
  /** An admin renamed it: its name no longer follows OSM. */
  nameLocked?: boolean;
}

export interface RouteDecisions {
  /** Relations with no feature yet, and the name to mint each with. */
  mint: { relation: number; name: string }[];
  /** Features whose name follows OSM's new one. */
  rename: { id: string; name: string }[];
  /** Retired features whose relation is back. */
  reactivate: string[];
  /** Active features whose relation is in no area's build. */
  retire: string[];
}

/**
 * Match the registry's routes to every bike route the builds have (`present`: relation → name).
 * A relation that leaves OSM retires its feature, and one that comes back makes it active again.
 */
export function reconcileRoutes(
  registered: readonly RegisteredRoute[],
  present: ReadonlyMap<number, string>,
): RouteDecisions {
  const d: RouteDecisions = {
    mint: [],
    rename: [],
    reactivate: [],
    retire: [],
  };
  const known = new Set<number>();
  for (const f of registered) {
    known.add(f.relation);
    const name = present.get(f.relation);
    if (name === undefined) {
      if (f.status === "active") d.retire.push(f.id);
      continue;
    }
    if (f.status === "retired") d.reactivate.push(f.id);
    if (!f.nameLocked && f.name !== name) d.rename.push({ id: f.id, name });
  }
  for (const [relation, name] of [...present].sort(([a], [b]) => a - b))
    if (!known.has(relation)) d.mint.push({ relation, name });
  return d;
}
