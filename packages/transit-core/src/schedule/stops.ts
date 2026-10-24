// How far apart a route's stops are and how fast its trips are timetabled (packages/transit-core/DESIGN.md#stops-and-speed):
// the route card's Stops section, the stop spacing categories (packages/shared/src/stop-spacing.ts)
// and the layers panel's Fast Bus switch. Only stops passengers can use count: a layover or timing
// point with no boarding or alighting isn't a stop riders see.

import { indexCalendar } from "../gtfs/calendar.ts";
import {
  isPassengerStop,
  patternTripCounts,
  type PlanPattern,
  type PlanTrip,
  type ServicePlan,
} from "../plan/types.ts";
import type { ServiceDate } from "../time.ts";
import type { PreparedPlan } from "./engine.ts";
import { DAY_WINDOW, regularWeekdays, type ServicesOn } from "./frequency.ts";

const HOUR = 3600;

/** A route's stops, as `PlanRoute.stops` stores them. */
export interface RouteStops {
  /**
   * Average stop spacing (m): every trip's length from its first passenger stop to its last,
   * divided by its stops less one, over all of them (TransLink's measure, weighted by trips).
   */
  spacing: number;
  /** Its busiest pattern: passenger stops, length (m) and where its trips go (GTFS headsign). */
  count: number;
  length: number;
  headsign: string;
}

/** The first and last passenger stops of a pattern; undefined with fewer than two. */
function passengerEnds(p: PlanPattern): [number, number] | undefined {
  let first = -1;
  let last = -1;
  for (let i = 0; i < p.stops.length; i++)
    if (isPassengerStop(p, i)) {
      if (first < 0) first = i;
      last = i;
    }
  return first >= 0 && last > first ? [first, last] : undefined;
}

function passengerStops(p: PlanPattern): number {
  let n = 0;
  for (let i = 0; i < p.stops.length; i++) if (isPassengerStop(p, i)) n++;
  return n;
}

/** Every route's stops (`RouteStops`), for the published plan; routes without trips have none. */
export function routeStops(
  plan: Pick<ServicePlan, "patterns" | "trips" | "routes">,
): Map<string, RouteStops> {
  const trips = patternTripCounts(plan);
  const headsigns = new Map<number, Map<string, number>>();
  for (const t of plan.trips) {
    let m = headsigns.get(t.pattern);
    if (!m) headsigns.set(t.pattern, (m = new Map()));
    m.set(t.headsign, (m.get(t.headsign) ?? 0) + 1);
  }
  const acc = new Map<
    string,
    { metres: number; gaps: number; main?: PlanPattern; mainTrips: number }
  >();
  for (const p of plan.patterns) {
    const n = trips[p.id] ?? 0;
    const ends = passengerEnds(p);
    if (!n || !ends) continue;
    let a = acc.get(p.route);
    if (!a) acc.set(p.route, (a = { metres: 0, gaps: 0, mainTrips: 0 }));
    a.metres += n * (p.dist[ends[1]]! - p.dist[ends[0]]!);
    a.gaps += n * (passengerStops(p) - 1);
    if (n > a.mainTrips) {
      a.main = p;
      a.mainTrips = n;
    }
  }
  const out = new Map<string, RouteStops>();
  for (const [route, a] of acc) {
    const main = a.main!;
    const [first, last] = passengerEnds(main)!;
    const signs = [...(headsigns.get(main.id) ?? [])];
    const headsign = signs.reduce<[string, number]>(
      (best, s) => (s[1] > best[1] ? s : best),
      ["", 0],
    )[0];
    out.set(route, {
      spacing: Math.round(a.metres / a.gaps),
      count: passengerStops(main),
      length: Math.round(main.dist[last]! - main.dist[first]!),
      headsign,
    });
  }
  return out;
}

/**
 * A trip's scheduled run: metres from its first passenger stop to its last and the seconds it's
 * timetabled to take (departure to arrival); undefined when it has no time to take.
 */
export function tripRun(
  p: PlanPattern,
  t: PlanTrip,
): [metres: number, seconds: number] | undefined {
  const ends = passengerEnds(p);
  if (!ends) return undefined;
  const [first, last] = ends;
  const s = t.arr[last]! - (t.dep ?? t.arr)[first]!;
  return s > 0 ? [p.dist[last]! - p.dist[first]!, s] : undefined;
}

/** Total length over total time of some runs, in km/h; undefined without any. */
function speedOf(runs: Iterable<[number, number]>): number | undefined {
  let m = 0;
  let s = 0;
  for (const [a, b] of runs) {
    m += a;
    s += b;
  }
  return s > 0 ? (m / s) * 3.6 : undefined;
}

/**
 * A route's scheduled speed (km/h) on a date: of its trips starting in the `seconds` from `from`
 * (service seconds), both directions, total length over total time, so long trips count for more.
 * From the trips the prepared plan has (the browser's: those of the shown dates); undefined when
 * none of them start then.
 */
export function routeSpeed(
  pp: PreparedPlan,
  routeKey: string,
  date: ServiceDate,
  from: number,
  seconds: number,
): number | undefined {
  const runs: [number, number][] = [];
  for (const service of pp.servicesOn(date)) {
    const list = pp.tripsByService.get(service);
    if (!list) continue;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.trip.start < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length; i++) {
      const pt = list[i]!;
      if (pt.trip.start >= from + seconds) break;
      if (pt.route.key !== routeKey) continue;
      const run = tripRun(pt.pattern, pt.trip);
      if (run) runs.push(run);
    }
  }
  return speedOf(runs);
}

/**
 * Its slowest and fastest hour on regular weekdays (`regularWeekdays`), by when trips start, over
 * DAY_WINDOW: late at night a few fast trips would stretch the range.
 */
export function weekdaySpeedRange(
  servicesOn: ServicesOn,
  days: readonly ServiceDate[],
  runs: readonly { service: string; start: number; run: [number, number] }[],
): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const date of days) {
    const services = new Set(servicesOn(date));
    for (let h = DAY_WINDOW.fromH; h < DAY_WINDOW.toH; h++) {
      const v = speedOf(
        runs
          .filter(
            (r) =>
              services.has(r.service)
              && r.start >= h * HOUR
              && r.start < (h + 1) * HOUR,
          )
          .map((r) => r.run),
      );
      if (v === undefined) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return Number.isFinite(lo) ? [Math.round(lo), Math.round(hi)] : undefined;
}

/** Every route's `weekdaySpeedRange`, for the published plan (`PlanRoute.weekdaySpeed`). */
export function routeWeekdaySpeeds(
  plan: Pick<
    ServicePlan,
    "patterns" | "trips" | "calendar" | "feedStart" | "feedEnd"
  >,
): Map<string, [number, number]> {
  const servicesOn = indexCalendar(plan.calendar);
  const days = regularWeekdays(servicesOn, plan.feedStart, plan.feedEnd);
  const byRoute = new Map<
    string,
    { service: string; start: number; run: [number, number] }[]
  >();
  for (const t of plan.trips) {
    const p = plan.patterns[t.pattern]!;
    const run = tripRun(p, t);
    if (!run) continue;
    let list = byRoute.get(p.route);
    if (!list) byRoute.set(p.route, (list = []));
    list.push({ service: t.service, start: t.start, run });
  }
  const out = new Map<string, [number, number]>();
  for (const [route, runs] of byRoute) {
    const range = weekdaySpeedRange(servicesOn, days, runs);
    if (range) out.set(route, range);
  }
  return out;
}
