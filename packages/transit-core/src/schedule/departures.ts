// Departures from a stop or station, for the site's stop and station cards
// (packages/transit-core/DESIGN.md#departures): the timetable's effective departure times (re-timed
// rail, modelled dwell), shifted where real-time corrections know a trip's delay, grouped by route
// and destination, with how often each group runs and the stretches groups share.

import { STOP_NO_PICKUP, type ServicePlan } from "../plan/types.ts";
import { placeName as stopName } from "../plan/display.ts";
import { bayNumber } from "../plan/exchanges.ts";
import { serviceDayStart, type ServiceDate } from "../time.ts";
import { frequencyOf, type Frequency } from "./frequency.ts";
import {
  shiftAt,
  type PreparedPlan,
  type ScheduleCorrections,
} from "./engine.ts";

export interface Departure {
  tripId: string;
  routeKey: string;
  headsign: string;
  /** The stop it leaves from (a platform, at a station). */
  stopId: string;
  /** Its platform (rail) or bay (an exchange's or station's bus bay), where numbered. */
  platform?: string | undefined;
  pattern: number;
  /** Index of that stop in the pattern. */
  index: number;
  serviceDate: ServiceDate;
  /** Epoch ms, shifted by real-time corrections where known. */
  t: number;
  /** Epoch ms, from the timetable. */
  sched: number;
  /**
   * Where the time comes from: the timetable, a delay predicted from real-time data (`predicted`:
   * the correction is a projection), or a sighting (`observed`).
   */
  source: "schedule" | "predicted" | "observed";
  cancelled: boolean;
}

/** The plan's stops for a station (its platforms, and any bus bays given) or a single stop. */
export function stopsOf(
  plan: ServicePlan,
  id: string,
  bays: readonly string[] = [],
): Set<string> {
  const out = new Set<string>([id, ...bays]);
  for (const s of plan.stops) if (s.parent === id) out.add(s.id);
  return out;
}

/**
 * Departures from `stops` between `from` and `to` (epoch ms), soonest first. Searches the given
 * service dates (pass the previous day too: its late trips run after midnight). Trips ending at the
 * stop aren't departures, nor are stops where nobody can board.
 */
export function departuresAt(
  pp: PreparedPlan,
  stops: ReadonlySet<string>,
  from: number,
  to: number,
  dates: readonly ServiceDate[],
  corrections?: (date: ServiceDate) => ScheduleCorrections | undefined,
): Departure[] {
  const { plan } = pp;
  // Pattern → indices of the stops (not the last one: nothing departs from a trip's end).
  const hits = new Map<number, number[]>();
  for (const p of plan.patterns) {
    const idx: number[] = [];
    for (let i = 0; i < p.stops.length - 1; i++)
      if (
        stops.has(plan.stops[p.stops[i]!]!.id)
        && ((p.access?.[i] ?? 0) & STOP_NO_PICKUP) === 0
      )
        idx.push(i);
    if (idx.length) hits.set(p.id, idx);
  }
  const out: Departure[] = [];
  for (const date of dates) {
    const day = serviceDayStart(date);
    const fix = corrections?.(date);
    for (const service of pp.servicesOn(date)) {
      const trips = pp.tripsByService.get(service) ?? [];
      const span = (pp.maxSpanByService.get(service) ?? 0) * 1000;
      for (const pt of trips) {
        const start = day + pt.trip.start * 1000;
        if (start > to) break; // sorted by start
        if (start + span < from) continue;
        const idx = hits.get(pt.pattern.id);
        if (!idx) continue;
        const c = fix?.trips.get(pt.trip.id);
        for (const i of idx) {
          const sched = day + pt.dep[i]! * 1000;
          const t = sched + shiftAt(c?.anchors, pt.dep[i]!) * 1000;
          if (t < from || t > to) continue;
          const stop = plan.stops[pt.pattern.stops[i]!]!;
          out.push({
            tripId: pt.trip.id,
            routeKey: pt.route.key,
            headsign: pt.trip.headsign,
            stopId: stop.id,
            platform: stop.platform ?? bayNumber(stop.name),
            pattern: pt.pattern.id,
            index: i,
            serviceDate: date,
            t,
            sched,
            source:
              !c ? "schedule"
              : c.estimate ? "predicted"
              : "observed",
            cancelled: fix?.cancelled.has(pt.trip.id) ?? false,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface DepartureGroup {
  routeKey: string;
  headsign: string;
  /** Platforms (or bus bays) it leaves from, where known. */
  platforms: string[];
  departures: Departure[];
}

/**
 * One group per route + destination. Groups with a platform or bay are ordered by its number
 * (Platform 1 before 2, Bay 1 before 5), groups without one (a street stop) after; then by route
 * number (the 19 before the 240, then N24 and R5), then by soonest departure.
 */
export function groupDepartures(deps: readonly Departure[]): DepartureGroup[] {
  const groups = new Map<string, DepartureGroup>();
  for (const d of deps) {
    const key = `${d.routeKey}|${d.headsign}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        routeKey: d.routeKey,
        headsign: d.headsign,
        platforms: [],
        departures: [],
      };
      groups.set(key, g);
    }
    g.departures.push(d);
    if (d.platform && !g.platforms.includes(d.platform))
      g.platforms.push(d.platform);
  }
  // deps are sorted, so insertion order is by soonest departure; the stable sort keeps it within a route.
  return [...groups.values()].sort(
    (a, b) =>
      comparePlatforms(lowestPlatform(a), lowestPlatform(b))
      || byNumber.compare(a.routeKey, b.routeKey),
  );
}

const byNumber = new Intl.Collator(undefined, { numeric: true });

const lowestPlatform = (g: DepartureGroup): string | undefined =>
  [...g.platforms].sort(byNumber.compare)[0];

/** Numbered platforms in order ("2" before "10"), unnumbered last. */
function comparePlatforms(
  a: string | undefined,
  b: string | undefined,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return byNumber.compare(a, b);
}

/**
 * How often departures run in the hour from `from` (epoch ms), measured at the stop: the average
 * and the worst wait (schedule/frequency.ts → `frequencyOf`), or undefined when nothing departs
 * then. Cancelled trips don't count.
 */
export function departureFrequency(
  deps: readonly Departure[],
  from: number,
): Frequency | undefined {
  const times = deps.filter((d) => !d.cancelled).map((d) => d.t / 1000);
  return frequencyOf(times, from / 1000, 3600);
}

/** A stop's name for "to …" (plan/display.ts → placeName): the station ("Columbia"), exchange, or cross street ("Renfrew St"). */
export function placeName(plan: ServicePlan, stopId: string): string {
  const i = plan.stops.findIndex((s) => s.id === stopId);
  return i < 0 ? stopId : stopName(plan, i);
}

export interface SharedStretch {
  groups: DepartureGroup[];
  /** The last stop every group in it serves next, in order. */
  toStopId: string;
  departures: Departure[];
}

/**
 * Shared stretches need at least this many stops in common after this one, or this long in
 * common: routes running together only to the next corner aren't one service, but a short-turn of
 * a rapid route with stops kilometres apart is (the 97's Queensway short-turns at Westside Rd: one
 * stop, 4.8 km). Product choices, not operating assumptions.
 */
const MIN_SHARED_STOPS = 2;
const MIN_SHARED_M = 500;

/** A stop after the one a trip leaves from: the plan's stop, its station (or itself) and how far on (m). */
export interface OnwardStop {
  stop: number;
  key: string;
  m: number;
}

/** The stops after stop `index` of a pattern. Stations are compared by station, not platform. */
export function onwardStops(
  plan: ServicePlan,
  pattern: number,
  index: number,
): OnwardStop[] {
  const p = plan.patterns[pattern]!;
  return p.stops.slice(index + 1).map((si, k) => {
    const s = plan.stops[si]!;
    return {
      stop: si,
      key: s.parent ?? s.id,
      m: p.dist[index + 1 + k]! - p.dist[index]!,
    };
  });
}

/**
 * Of the services leaving one stop (each given by its onward stops), those that run the same way
 * from it: the same next stops, in order, for at least MIN_SHARED_STOPS stops or MIN_SHARED_M.
 * Services with the same next stop are one run as far as they all go together; when that's too
 * short, the ones that carry on together past it are tried on their own (three routes to the next
 * stop, one turning off there: the other two can still share a stretch). Each run lists its
 * members (indices into `onward`) and how many stops they share. The one definition of a shared
 * stretch, for the stop cards (`sharedStretches`) and the map's bus corridors
 * (plan/corridor-frequency.ts), so the map never combines what a card doesn't.
 */
export function sharedRuns(
  onward: readonly (readonly OnwardStop[])[],
): { members: number[]; stops: number }[] {
  const out: { members: number[]; stops: number }[] = [];
  // Members known to share their first `from` stops.
  const visit = (members: number[], from: number) => {
    const byNext = new Map<string, number[]>();
    for (const i of members) {
      const k = onward[i]![from]?.key;
      if (k !== undefined) byNext.set(k, [...(byNext.get(k) ?? []), i]);
    }
    for (const group of byNext.values()) {
      if (group.length < 2) continue;
      let n = from + 1;
      for (;;) {
        const k = onward[group[0]!]![n]?.key;
        if (!k || !group.every((m) => onward[m]![n]?.key === k)) break;
        n++;
      }
      if (n >= MIN_SHARED_STOPS || onward[group[0]!]![n - 1]!.m >= MIN_SHARED_M)
        out.push({ members: group, stops: n });
      else visit(group, n);
    }
  };
  visit(
    onward.map((_, i) => i),
    0,
  );
  return out;
}

/**
 * Groups that run the same way from here (`sharedRuns`: e.g. both Expo Line branches to Columbia,
 * or the R5 and 14 along Hastings to Renfrew). Each stretch runs to where they split.
 */
export function sharedStretches(
  plan: ServicePlan,
  groups: readonly DepartureGroup[],
): SharedStretch[] {
  // Each group's onward stops, from its soonest departure's pattern.
  const onward = groups.map((g) =>
    onwardStops(plan, g.departures[0]!.pattern, g.departures[0]!.index),
  );
  return sharedRuns(onward).map(({ members, stops }) => {
    const gs = members.map((m) => groups[m]!);
    return {
      groups: gs,
      toStopId: plan.stops[onward[members[0]!]![stops - 1]!.stop]!.id,
      departures: gs.flatMap((g) => g.departures).sort((a, b) => a.t - b.t),
    };
  });
}
