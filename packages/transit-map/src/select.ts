// What `?select=` names (apps/web/README.md#modes-and-url-state, docs/DESIGN.md#feature-ids): a
// feature key, an ID (`sn-k3v9qd7m-waterfront`) or a ref (`stop:translink:50123`), turned into the
// engine's selection, and back. IDs are found in the plan version's places file; refs in the plan
// itself. Vehicles are the engine's own refs: `run:<run id>` (inferred runs, timetable vehicles)
// and `rt:<feed>:<vehicle id>` (GTFS-RT), and so are combined routes: `shared:<from>:<to>`, the keys
// of the stops or stations where they start and end.

import {
  formatRef,
  parseKey,
  type PlacesFile,
} from "@transitopia/shared/features.ts";
import type { BusHub } from "@transitopia/transit-core/plan/exchanges.ts";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { sharedEnds, sharedPlace, type Place } from "./url.ts";

export interface SelectContext {
  feed: string;
  plan: Pick<ServicePlan, "stations" | "stops" | "routes">;
  hubs: readonly BusHub[];
  /** The plan version's places file; null without one (no registry here). */
  places: PlacesFile | null;
}

export type Selection = { place: Place } | { vehicle: string };

/** The engine's id of a GTFS-RT vehicle (`rt:<vehicle id>`) and of everything else (a run id). */
const RT_PREFIX = "rt:";

/** A vehicle's key: `rt:<feed>:<id>` or `run:<id>`. */
export function vehicleKey(feed: string, engineId: string): string {
  return engineId.startsWith(RT_PREFIX) ?
      formatRef("rt", feed, engineId.slice(RT_PREFIX.length))
    : formatRef("run", "", engineId);
}

/** A vehicle key's engine id, if the key names a vehicle (of this feed, for `rt`). */
export function vehicleOfKey(key: string, feed: string): string | undefined {
  const k = parseKey(key);
  if (k?.form !== "ref") return undefined;
  if (k.scheme === "run") return k.value;
  if (k.scheme === "rt" && k.namespace === feed)
    return `${RT_PREFIX}${k.value}`;
  return undefined;
}

/**
 * The selection a key names here, "elsewhere" for a valid key this plan doesn't have (another
 * region's feature, or one only the resolver knows), or undefined for an invalid key.
 */
export function resolveSelect(
  key: string,
  ctx: SelectContext,
): Selection | "elsewhere" | undefined {
  const k = parseKey(key);
  if (!k) return undefined;
  const vehicle = vehicleOfKey(key, ctx.feed);
  if (vehicle) return { vehicle };
  if (k.form === "ref" && k.scheme === "shared")
    return resolveShared(k.value, ctx);
  const { plan, places } = ctx;
  if (k.form === "id") {
    if (!places) return "elsewhere";
    const id = places.redirects[k.id] ?? k.id;
    const idOf = (v: string) => {
      const p = parseKey(v);
      return p?.form === "id" ? p.id : undefined;
    };
    const find = (m: Record<string, string>) =>
      Object.keys(m).find((x) => idOf(m[x]!) === id);
    switch (k.kind) {
      case "station": {
        const s = find(places.stations);
        return s ? { place: { kind: "station", id: s } } : "elsewhere";
      }
      case "stop": {
        const s = find(places.stops);
        return s ? { place: { kind: "stop", id: s } } : "elsewhere";
      }
      case "route": {
        const r = find(places.routes);
        return r ? { place: { kind: "route", id: r } } : "elsewhere";
      }
      case "exchange": {
        // Hubs from the places file have the exchange's ID; the plan's own, its bays.
        const bays = new Set(
          Object.keys(places.parents).filter((s) => places.parents[s] === id),
        );
        const hub =
          ctx.hubs.find((h) => h.id === id)
          ?? ctx.hubs.find(
            (h) => !h.station && h.bays.some((b) => bays.has(b)),
          );
        return hub ? { place: { kind: "exchange", id: hub.id } } : "elsewhere";
      }
      default:
        return "elsewhere";
    }
  }
  if (k.namespace !== ctx.feed) return "elsewhere";
  switch (k.scheme) {
    case "gtfs-stop":
      if (plan.stations.some((s) => s.id === k.value))
        return { place: { kind: "station", id: k.value } };
      if (plan.stops.some((s) => s.id === k.value))
        return { place: { kind: "stop", id: k.value } };
      return "elsewhere";
    case "stop": {
      const s = plan.stops.find((x) => x.code === k.value);
      return s ? { place: { kind: "stop", id: s.id } } : "elsewhere";
    }
    case "gtfs-route": {
      const r = plan.routes.find((x) => x.gtfsRouteId === k.value);
      return r ? { place: { kind: "route", id: r.key } } : "elsewhere";
    }
    default:
      return "elsewhere";
  }
}

/**
 * A combined route's selection from its ends' keys ("<from>:<to>"; either may be a ref, which has
 * colons of its own: the first split where both halves name a station, exchange or stop here), or
 * undefined. An exchange stands for its bays: the end is one of them (`placeOfStop`).
 */
function resolveShared(
  value: string,
  ctx: SelectContext,
): Selection | undefined {
  const end = (key: string) => {
    const r = parseKey(key) && resolveSelect(key, ctx);
    if (!r || r === "elsewhere" || !("place" in r)) return undefined;
    const { kind, id } = r.place;
    if (kind === "exchange") return ctx.hubs.find((h) => h.id === id)?.bays[0];
    return kind === "stop" || kind === "station" ? id : undefined;
  };
  for (let i = value.indexOf(":"); i > 0; i = value.indexOf(":", i + 1)) {
    const from = end(value.slice(0, i));
    const to = from && end(value.slice(i + 1));
    if (from && to) return { place: sharedPlace(from, to) };
  }
  return undefined;
}

/**
 * The canonical key of a selection: the feature's ID with its current name suffix where the places
 * file has it, else a ref (a development machine without a registry, a preview, a feed version not
 * reconciled yet). An exchange has no ref (GTFS has no record of it), so without its ID it has no
 * key: undefined, and the URL names no selection rather than one that would reopen as a bay.
 */
export function selectKey(
  sel: Selection,
  ctx: SelectContext,
): string | undefined {
  if ("vehicle" in sel) return vehicleKey(ctx.feed, sel.vehicle);
  const { place } = sel;
  const { places, plan, feed } = ctx;
  switch (place.kind) {
    case "station":
      return (
        places?.stations[place.id] ?? formatRef("gtfs-stop", feed, place.id)
      );
    case "stop": {
      const key = places?.stops[place.id];
      if (key) return key;
      const code = plan.stops.find((s) => s.id === place.id)?.code;
      return code ?
          formatRef("stop", feed, code)
        : formatRef("gtfs-stop", feed, place.id);
    }
    case "route": {
      const key = places?.routes[place.id];
      if (key) return key;
      const r = plan.routes.find((x) => x.key === place.id);
      return formatRef("gtfs-route", feed, r?.gtfsRouteId ?? place.id);
    }
    case "shared": {
      // Each end: a station, an exchange (by one of its bays; the bay itself where the exchange
      // has no key), else a stop.
      const key = (id: string) => {
        if (plan.stations.some((s) => s.id === id))
          return selectKey({ place: { kind: "station", id } }, ctx);
        const exchange = ctx.hubs.find(
          (h) => !h.station && h.bays.includes(id),
        );
        return (
          (exchange
            && selectKey({ place: { kind: "exchange", id: exchange.id } }, ctx))
          || selectKey({ place: { kind: "stop", id } }, ctx)
        );
      };
      const { from, to } = sharedEnds(place);
      return formatRef("shared", "", `${key(from)}:${key(to)}`);
    }
    case "exchange": {
      if (places?.places[place.id]) return places.places[place.id]!.key;
      const hub = ctx.hubs.find((h) => h.id === place.id);
      const ex = hub?.bays
        .map((b) => places?.parents[b])
        .find((p) => p !== undefined && places?.places[p]?.kind === "exchange");
      return ex && places!.places[ex]!.key;
    }
  }
}
