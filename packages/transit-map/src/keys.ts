// How the engine names a route, stop or vehicle across feeds (packages/transit-map/README.md#feeds):
// a plan's keys and ids are unique only within its feed (the Fraser Valley's 3 and TransLink's 3), so
// wherever the engine holds things of several feeds (the vehicles drawn, the selection, hidden
// routes, the map's focus) they're "<feed>:<key>". Feed ids are slugs, so the first ":" splits one.

import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";

export function feedKey(feed: string, key: string): string {
  return `${feed}:${key}`;
}

/** A `feedKey`'s feed and key, or undefined when it isn't one. */
export function splitFeedKey(
  k: string,
): { feed: string; key: string } | undefined {
  const i = k.indexOf(":");
  return i > 0 ? { feed: k.slice(0, i), key: k.slice(i + 1) } : undefined;
}

/** A route's key across feeds (TransitSnapshot.groups, hidden). */
export function routeId(r: Pick<PlanRoute, "feed" | "key">): string {
  return feedKey(r.feed, r.key);
}

/** A vehicle's id across feeds (TransitSnapshot.selected, CardTarget, PickChoice). */
export function vehicleId(v: Pick<VehicleState, "feed" | "id">): string {
  return feedKey(v.feed, v.id);
}
