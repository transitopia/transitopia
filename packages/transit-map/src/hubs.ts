// Bus exchanges and stations' bays as the registry groups them (docs/DESIGN.md#relationships-between-features):
// from a plan version's places file, which says which station or exchange each stop is in. An
// admin's grouping (Blanca Loop's bays are ordinary stops; a bay moved to another exchange) shows
// here within minutes, without a plan rebuild. Without a places file the plan's own grouping is
// used (`ServicePlan.hubs`, built by `busHubs` in build-schedule); the browser never runs `busHubs`.

import { parseKey, type PlacesFile } from "@transitopia/shared/features.ts";
import {
  busStopRoutes,
  byBay,
  type BusHub,
} from "@transitopia/transit-core/plan/exchanges.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";

/**
 * The plan's stops in each station and exchange its places file names (by the place's ID): those
 * that aren't platforms (no GTFS parent) or rail and ferry stops, as stop indices. A place another
 * feed draws (a station of TransLink's that the Fraser Valley's 66 stops at) has its bays here too.
 */
export function baysFromPlaces(
  plan: Pick<ServicePlan, "routes" | "patterns" | "stops">,
  places: PlacesFile,
): Map<string, number[]> {
  // From every pattern, not the trips loaded so far: the hubs are worked out once per plan and
  // places file (`hubsOf`), and a places file in before the first trips would leave every exchange
  // out until the page was reloaded.
  const { routes, patterns, stops } = plan;
  const served = busStopRoutes({ routes, patterns, stops });
  const indexOf = new Map(plan.stops.map((s, i) => [s.id, i]));
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
  return bays;
}

/**
 * The plan's hubs from its places file: each exchange and each station with the plan's stops in it
 * (`baysFromPlaces`), by bay number. An exchange none of whose stops a drawn bus serves isn't one
 * yet (as with `busHubs`); a station's bays always are. Ids are the features' IDs.
 */
export function hubsFromPlaces(
  plan: Pick<ServicePlan, "routes" | "patterns" | "stops" | "stations">,
  places: PlacesFile,
): BusHub[] {
  // From every pattern, as `baysFromPlaces`.
  const { routes, patterns, stops } = plan;
  const served = busStopRoutes({ routes, patterns, stops });
  const stationOf = new Map<string, string>();
  for (const [planId, key] of Object.entries(places.stations)) {
    const k = parseKey(key);
    if (k?.form === "id" && !stationOf.has(k.id)) stationOf.set(k.id, planId);
  }
  const out: BusHub[] = [];
  for (const [id, sis] of baysFromPlaces(plan, places)) {
    const place = places.places[id];
    if (!place) continue;
    const station = place.kind === "station" ? stationOf.get(id) : undefined;
    // A station's stops without a plan station of its own: not drawn here, so no hub (another
    // feed's card for the station lists them, src/engine.ts → foreignBays).
    if (place.kind === "station" && station === undefined) continue;
    const routesHere = [
      ...new Set(sis.flatMap((si) => [...(served.get(si) ?? [])])),
    ].sort();
    if (place.kind === "exchange" && !routesHere.length) continue;
    const bays = sis.map((si) => stops[si]!).sort(byBay);
    out.push({
      id,
      name: place.name,
      lon: place.lon,
      lat: place.lat,
      bays: bays.map((s) => s.id),
      routes: routesHere,
      ...(station !== undefined ? { station } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The ID (registry feature ID) of a plan station, from its places file, if it has one. */
export function stationFeatureId(
  places: PlacesFile,
  station: string,
): string | undefined {
  const k = parseKey(places.stations[station] ?? "");
  return k?.form === "id" ? k.id : undefined;
}
