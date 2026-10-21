// What a station, bus exchange, bus stop or route line card shows (packages/transit-map/README.md):
// the place, the routes serving it, and its departures after the shown time from the timetable
// shifted by the real-time corrections the vehicles use (packages/transit-core/DESIGN.md#departures).

import {
  addDays,
  serviceDayStart,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";
import type {
  PlanRoute,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  bayLabel,
  type BusHub,
} from "@transitopia/transit-core/plan/exchanges.ts";
import type {
  PreparedPlan,
  ScheduleCorrections,
  VehicleState,
} from "@transitopia/transit-core/schedule/engine.ts";
import {
  departureFrequency,
  departuresAt,
  groupDepartures,
  placeName,
  sharedStretches,
  type SharedStretch,
  stopsOf,
  type Departure,
} from "@transitopia/transit-core/schedule/departures.ts";
import {
  routeFrequency,
  type Frequency,
  type Starts,
} from "@transitopia/transit-core/schedule/frequency.ts";
import {
  segmentFrequency,
  sharedStart,
} from "@transitopia/transit-core/schedule/shared-segment.ts";
import { displayServiceDate, hubsOf, placeOfStop } from "./plans.ts";
import { sharedPlace, type Place } from "./url.ts";

/** A route + destination leaving a station or stop, with its next departures. */
export interface PlaceGroup {
  route: PlanRoute;
  headsign: string;
  platforms: string[];
  /** The next few departures (cancelled ones included, marked). */
  departures: Departure[];
  /** How often it leaves in the hour from the shown time (timetable, real-time where known). */
  frequency: Frequency | undefined;
  /** Stops it leaves from (at a station: platforms or bus bays), by GTFS stop_id. */
  stopIds: string[];
  /** The vehicle on the map running its next departure, if that trip is drawn yet. */
  vehicle: string | undefined;
  /**
   * Where its next departure ends ("Boundary Loop"): the station or exchange that stop belongs to,
   * else the stop. Absent when that's this place (a loop).
   */
  terminus: { place: Place; name: string } | undefined;
}

/** The selected route line: how often it runs now and how many of its vehicles are out. */
export interface RouteSnapshot {
  kind: "route";
  id: string;
  route: PlanRoute;
  /** How often its trips start in the hour from the shown time (timetable), better direction. */
  nextHour: Frequency | undefined;
  /** Its vehicles drawn now, and how many of them have real positions. */
  vehicles: number;
  live: number;
  /** Registry ids of the data behind it, for its card's credits. */
  datasets: string[];
}

/**
 * The selected combined route (packages/transit-core/DESIGN.md#combined-routes): the routes running
 * together from one stop to another, and how often they leave its start.
 */
export interface SharedSnapshot {
  kind: "shared";
  id: string;
  /** Its routes, in the plan's order; none when no route runs the stretch in this timetable. */
  routes: PlanRoute[];
  /** Where it starts and ends ("Commercial-Broadway", "17 St"). */
  from: string;
  to: string;
  /** How often its buses leave its start in the hour from the shown time (timetable). */
  nextHour: Frequency | undefined;
  /** Registry ids of the data behind it, for its card's credits. */
  datasets: string[];
}

/** The selected station, bus exchange or bus stop and what leaves it after the shown time. */
export interface PlaceSnapshot extends Place {
  kind: "station" | "exchange" | "stop";
  /** As in GTFS: "Stadium-Chinatown Station", "Eastbound E Hastings St @ Main St". */
  name: string;
  lon: number;
  lat: number;
  routes: PlanRoute[];
  groups: PlaceGroup[];
  /** Registry ids of the data behind its departures, for its card's credits. */
  datasets: string[];
  /** A bus stop's number on its sign (GTFS stop_code), where the plan has it. */
  code?: string | undefined;
  /** A station's or exchange's bus bays, by number: each has its own stop card. */
  bays: { id: string; label: string }[];
  /** The station or exchange a bay belongs to. */
  partOf?:
    { kind: "station" | "exchange"; id: string; name: string } | undefined;
  /** Groups running the same way from here, to where they split ("R5 or 14, to Renfrew St"). */
  shared: {
    routes: PlanRoute[];
    /** Platforms its trips leave from, where known. */
    platforms: string[];
    /** The groups it combines, as `${route key}|${headsign}`. */
    groups: string[];
    to: string;
    frequency: Frequency | undefined;
    /** The combined route it's part of, from where its routes come together (buses only, for now). */
    segment: Place | undefined;
  }[];
}

/**
 * One of the things a map tap could have meant, offered in a menu when there are several
 * (packages/transit-map/README.md#tap-menu): a vehicle, or a station, exchange, stop or route line.
 */
export type PickChoice =
  | {
      kind: "vehicle";
      id: string;
      vehicle: VehicleState;
      route: PlanRoute | undefined;
    }
  | {
      kind: "place";
      place: Place;
      /** "Commercial-Broadway", "Eastbound E Hastings St @ Main St", "99 B-Line". */
      name: string;
      /** A bus stop's number on its sign. */
      code?: string | undefined;
      /** A route line's route. */
      route?: PlanRoute | undefined;
    };

/** The menu a tap near several things opens, at the tap (viewport px). */
export interface PickMenu {
  x: number;
  y: number;
  choices: PickChoice[];
}

/** A station, exchange, stop or route as a menu choice, or undefined if the shown feed hasn't it. */
export function placeChoice(
  pp: PreparedPlan,
  place: Place,
): PickChoice | undefined {
  const { plan } = pp;
  if (place.kind === "shared") return undefined;
  if (place.kind === "route") {
    const route = pp.routes.get(place.id);
    return route && { kind: "place", place, name: route.label, route };
  }
  if (place.kind === "station") {
    const s = plan.stations.find((x) => x.id === place.id);
    return s && { kind: "place", place, name: s.name };
  }
  if (place.kind === "exchange") {
    const h = hubsOf(plan).find((x) => x.id === place.id);
    return h && { kind: "place", place, name: h.name };
  }
  const stop = pp.stopById.get(place.id);
  return stop && { kind: "place", place, name: stop.name, code: stop.code };
}

/** Station and stop cards list departures this far ahead of the shown time. */
const DEPARTURES_AHEAD_MS = 2 * 3600_000;
/** …showing this many per route and destination. */
const DEPARTURES_PER_GROUP = 3;

/** What a card's snapshot is computed from, besides the place. */
export interface PlaceContext {
  /** The shown feed. */
  pp: PreparedPlan;
  /** The shown instant (epoch ms). */
  t: number;
  /** Every vehicle computed for t, and whether one is drawn (its route shown, and not a hidden estimate). */
  vehicles: VehicleState[];
  drawn: (v: VehicleState) => boolean;
  /** The real-time corrections the vehicles use, per service date. */
  corrections: (date: ServiceDate) => ScheduleCorrections | undefined;
  /** The datasets behind routes (each with whether real-time data is shown for it), for credits. */
  datasetsOf: (routes: Iterable<[PlanRoute | undefined, boolean]>) => string[];
  /** A combined route's segment and whether a vehicle is on it, for its card. */
  segment: (p: Place) => SegmentContext | undefined;
}

/** What a combined route's card is worked out from (the engine keeps it per plan). */
export interface SegmentContext {
  routes: string[];
  /** Its departures from its start, as frequency sources. */
  sources: Starts[];
  onSegment: (v: VehicleState) => boolean;
}

/** Where a station, exchange or stop is ([lon, lat]), for its highlight and "Centre on map". */
export function placeLocation(
  pp: PreparedPlan,
  p: Place,
): [number, number] | undefined {
  const { plan } = pp;
  if (p.kind === "route" || p.kind === "shared") return undefined;
  const at =
    p.kind === "station" ? plan.stations.find((s) => s.id === p.id)
    : p.kind === "exchange" ? hubsOf(plan).find((h) => h.id === p.id)
    : pp.stopById.get(p.id);
  return at ? [at.lon, at.lat] : undefined;
}

/** A place's card at ctx.t, or undefined if the shown feed doesn't have it. */
export function placeSnapshot(
  p: Place,
  ctx: PlaceContext,
): PlaceSnapshot | RouteSnapshot | SharedSnapshot | undefined {
  const { pp, t } = ctx;
  if (p.kind === "shared") return sharedSnapshot(p, ctx);
  if (p.kind === "route") {
    const route = pp.routes.get(p.id);
    if (!route) return undefined;
    const date = displayServiceDate(t);
    // Whole seconds, so the value only changes when a trip enters or leaves the hour.
    const sec = Math.floor((t - serviceDayStart(date)) / 1000);
    const mine = ctx.vehicles.filter((v) => v.routeKey === p.id);
    return {
      kind: "route",
      id: p.id,
      route,
      nextHour: routeFrequency(pp, p.id, date, sec, 3600),
      vehicles: mine.length,
      live: mine.filter((v) => v.provenance !== "estimated").length,
      datasets: ctx.datasetsOf([
        [route, mine.some((v) => v.provenance !== "estimated")],
      ]),
    };
  }
  const { plan } = pp;
  const hubs = hubsOf(plan);
  // A station's bus bays, or the exchange itself.
  const hub =
    p.kind === "station" ? hubs.find((h) => h.station === p.id)
    : p.kind === "exchange" ? hubs.find((h) => h.id === p.id)
    : undefined;
  const where =
    p.kind === "station" ? plan.stations.find((s) => s.id === p.id)
    : p.kind === "exchange" ? hub
    : pp.stopById.get(p.id);
  if (!where) return undefined;
  const date = displayServiceDate(t);
  const stopIds =
    p.kind === "exchange" ? new Set(hub!.bays) : stopsOf(plan, p.id, hub?.bays);
  const deps = departuresAt(
    pp,
    stopIds,
    t,
    t + DEPARTURES_AHEAD_MS,
    [addDays(date, -1), date],
    ctx.corrections,
  );
  const groups = groupDepartures(deps);
  // Departures' routes are the plan's; a places file's hub may name one this version hasn't.
  const routeOf = (k: string): PlanRoute => pp.routes.get(k)!;
  // Vehicles on the map by the trip they're running, for "View bus" on a departure.
  const drawn = new Map(
    ctx.vehicles
      .filter(ctx.drawn)
      .map((v) => [`${v.serviceDate}|${v.tripId}`, v.id]),
  );
  const routeKeys =
    p.kind === "station" || p.kind === "exchange" ?
      [
        ...new Set([
          ...(where as { routes: string[] }).routes,
          ...(hub?.routes ?? []),
        ]),
      ]
    : [
        ...new Set(
          plan.patterns
            .filter((pt) => pt.stops.some((i) => plan.stops[i]!.id === p.id))
            .map((pt) => pt.route),
        ),
      ];
  const stopName = (id: string) => pp.stopById.get(id)?.name ?? id;
  const parent =
    p.kind === "stop" ? hubs.find((h) => h.bays.includes(p.id)) : undefined;
  // A trip's last stop as a card: its station, its exchange (or station's bays), or the stop.
  const terminusOf = (d: Departure): PlaceGroup["terminus"] => {
    const stops = plan.patterns[d.pattern]!.stops;
    const stop = plan.stops[stops[stops.length - 1]!]!;
    const hub = hubs.find((h) => h.bays.includes(stop.id));
    const place: Place =
      stop.parent && plan.stations.some((s) => s.id === stop.parent) ?
        { kind: "station", id: stop.parent }
      : hub ? parentPlace(hub)
      : { kind: "stop", id: stop.id };
    const here = [p, ...(parent ? [parentPlace(parent)] : [])];
    return here.some((h) => h.kind === place.kind && h.id === place.id) ?
        undefined
      : {
          place,
          // A street stop in full ("Boundary Rd @ Lougheed Hwy"): its cross street alone is no name.
          name:
            place.kind === "stop" ?
              stop.name.replace(/^(North|South|East|West)bound\s+/i, "")
            : placeName(plan, stop.id),
        };
  };
  return {
    ...p,
    kind: p.kind,
    name: where.name,
    code: "code" in where ? where.code : undefined,
    bays: (hub?.bays ?? []).map((id) => ({
      id,
      label: bayLabel(stopName(id)),
    })),
    partOf:
      parent
      && (parent.station ?
        {
          kind: "station",
          id: parent.station,
          name:
            plan.stations.find((s) => s.id === parent.station)?.name
            ?? parent.name,
        }
      : { kind: "exchange", id: parent.id, name: parent.name }),
    lon: where.lon,
    lat: where.lat,
    routes: routeKeys.flatMap((k) => pp.routes.get(k) ?? []),
    datasets: ctx.datasetsOf([
      ...routeKeys.map((k): [PlanRoute | undefined, boolean] => [
        routeOf(k),
        false,
      ]),
      ...groups.map((g): [PlanRoute | undefined, boolean] => [
        routeOf(g.routeKey),
        g.departures.some((d) => d.source !== "schedule"),
      ]),
    ]),
    groups: groups.map((g) => ({
      route: routeOf(g.routeKey),
      headsign: g.headsign,
      platforms: g.platforms,
      departures: g.departures.slice(0, DEPARTURES_PER_GROUP),
      frequency: departureFrequency(g.departures, t),
      stopIds: [...new Set(g.departures.map((d) => d.stopId))],
      vehicle: (() => {
        const next = g.departures.find((d) => !d.cancelled);
        return next && drawn.get(`${next.serviceDate}|${next.tripId}`);
      })(),
      terminus: terminusOf(
        g.departures.find((d) => !d.cancelled) ?? g.departures[0]!,
      ),
    })),
    shared: sharedStretches(plan, groups).map((s) => {
      const routes = [...new Set(s.groups.map((g) => g.routeKey))].map(routeOf);
      return {
        routes,
        platforms: [...new Set(s.groups.flatMap((g) => g.platforms))].sort(),
        groups: s.groups.map((g) => `${g.routeKey}|${g.headsign}`),
        to: placeName(plan, s.toStopId),
        frequency: departureFrequency(s.departures, t),
        segment: sharedSegmentOf(plan, s),
      };
    }),
  };
}

/**
 * A shared stretch's combined route: from where its routes came together, comparing stops by their
 * station or exchange (`placeOfStop`), to where they split.
 */
function sharedSegmentOf(
  plan: ServicePlan,
  s: SharedStretch,
): Place | undefined {
  const placeOf = placeOfStop(plan);
  const from = sharedStart(
    plan,
    s.groups.map((g) => ({
      pattern: g.departures[0]!.pattern,
      index: g.departures[0]!.index,
    })),
    placeOf,
  );
  const end = placeOf(s.toStopId);
  const to = plan.stations.some((x) => x.id === end) ? end : s.toStopId;
  return placeOf(from) === end ? undefined : sharedPlace(from, to);
}

/** A combined route's card at ctx.t (`SharedSnapshot`). */
function sharedSnapshot(p: Place, ctx: PlaceContext): SharedSnapshot {
  const { pp, t } = ctx;
  const { plan } = pp;
  const [from, to] = p.id.split(">") as [string, string];
  const seg = ctx.segment(p);
  const routes = (seg?.routes ?? []).flatMap((k) => pp.routes.get(k) ?? []);
  const date = displayServiceDate(t);
  const sec = Math.floor((t - serviceDayStart(date)) / 1000);
  // Real positions on it, for the credits.
  const live =
    seg ?
      ctx.vehicles.filter(
        (v) => v.provenance !== "estimated" && seg.onSegment(v),
      )
    : [];
  // A station, an exchange (by one of its bays), or a stop's cross street.
  const name = (key: string) =>
    plan.stations.find((s) => s.id === key)?.name.replace(/\s+Station$/i, "")
    ?? hubsOf(plan).find((h) => !h.station && h.bays.includes(key))?.name
    ?? placeName(plan, key);
  return {
    kind: "shared",
    id: p.id,
    routes,
    from: name(from),
    to: name(to),
    nextHour:
      seg && segmentFrequency(pp.servicesOn, seg.sources, date, sec, 3600),
    datasets: ctx.datasetsOf(
      routes.map((r): [PlanRoute, boolean] => [
        r,
        live.some((v) => v.routeKey === r.key),
      ]),
    ),
  };
}

/** The card for a station's bus bays or an exchange. */
function parentPlace(hub: BusHub): Place {
  return hub.station ?
      { kind: "station", id: hub.station }
    : { kind: "exchange", id: hub.id };
}
