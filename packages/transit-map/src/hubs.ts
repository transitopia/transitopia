// Bus exchanges and stations' bays as the registry groups them (docs/DESIGN.md#relationships-between-features):
// from a plan version's places file, which says which station or exchange each stop is in. An
// admin's grouping (Blanca Loop's bays are ordinary stops; a bay moved to another exchange) shows
// here within minutes, without a plan rebuild. Without a places file the plan's own grouping is
// used (`ServicePlan.hubs`, built by `busHubs` in build-schedule); the browser never runs `busHubs`.

import type { PlacesFile } from "@transitopia/shared/features.ts";
import {
  busStopRoutes,
  byBay,
  type BusHub,
} from "@transitopia/transit-core/plan/exchanges.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";

/**
 * The plan's hubs from its places file: each exchange and each station with the plan's stops in it
 * that aren't platforms (no GTFS parent) or rail and ferry stops, by bay number. An exchange none
 * of whose stops a drawn bus serves isn't one yet (as with `busHubs`); a station's bays always are.
 * Ids are the features' IDs.
 */
export function hubsFromPlaces(
  plan: Pick<
    ServicePlan,
    "routes" | "patterns" | "trips" | "stops" | "stations"
  >,
  places: PlacesFile,
): BusHub[] {
  const served = busStopRoutes(plan);
  const indexOf = new Map(plan.stops.map((s, i) => [s.id, i]));
  const stationOf = new Map<string, string>();
  for (const [planId, key] of Object.entries(places.stations)) {
    const id = /^([a-z]{2,3}-[0-9a-z]{8})/.exec(key)?.[1];
    if (id && !stationOf.has(id)) stationOf.set(id, planId);
  }
  const bays = new Map<string, number[]>();
  for (const [stopId, placeId] of Object.entries(places.parents)) {
    const si = indexOf.get(stopId);
    if (si === undefined) continue;
    const s = plan.stops[si]!;
    if (s.parent !== undefined || served.nonBus.has(si)) continue;
    let l = bays.get(placeId);
    if (!l) bays.set(placeId, (l = []));
    l.push(si);
  }
  const out: BusHub[] = [];
  for (const [id, sis] of bays) {
    const place = places.places[id];
    if (!place) continue;
    const station = place.kind === "station" ? stationOf.get(id) : undefined;
    // A station's stops without a plan station of its own: not drawn, so no hub.
    if (place.kind === "station" && station === undefined) continue;
    const routes = [
      ...new Set(sis.flatMap((si) => [...(served.get(si) ?? [])])),
    ].sort();
    if (place.kind === "exchange" && !routes.length) continue;
    const stops = sis.map((si) => plan.stops[si]!).sort(byBay);
    out.push({
      id,
      name: place.name,
      lon: place.lon,
      lat: place.lat,
      bays: stops.map((s) => s.id),
      routes,
      ...(station !== undefined ? { station } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
