// Departures from a stop or station, for the site's stop and station cards
// (packages/transit-core/DESIGN.md#departures): the timetable's effective departure times (re-timed
// rail, modelled dwell), shifted where real-time corrections know a trip's delay, grouped by route
// and destination, with how often each group runs and the stretches groups share.

import { STOP_NO_PICKUP, type ServicePlan } from "../plan/types.ts";
import { busStopLabel } from "../plan/bus-stops.ts";
import { serviceDayStart } from "../time.ts";
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
  platform?: string | undefined;
  pattern: number;
  /** Index of that stop in the pattern. */
  index: number;
  serviceDate: string;
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

/** The plan's stops for a station (its platforms) or a single stop. */
export function stopsOf(plan: ServicePlan, id: string): Set<string> {
  const out = new Set<string>([id]);
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
  dates: readonly string[],
  corrections?: (date: string) => ScheduleCorrections | undefined,
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
            platform: stop.platform,
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
  /** Platforms it leaves from, where known (a station's). */
  platforms: string[];
  departures: Departure[];
}

/** One group per route + destination, ordered by each group's soonest departure. */
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
  // deps are sorted, so insertion order is already by soonest departure.
  return [...groups.values()];
}

/**
 * Average minutes between departures in the hour from `from` (60 / departures that hour), or
 * undefined when nothing departs then. Cancelled trips don't count.
 */
export function minutesBetween(
  deps: readonly Departure[],
  from: number,
): number | undefined {
  const n = deps.filter(
    (d) => !d.cancelled && d.t >= from && d.t < from + 3600_000,
  ).length;
  return n ? 60 / n : undefined;
}

/** A stop's name for "to …": the station ("Columbia"), or a street stop's cross street ("Renfrew St"). */
export function placeName(plan: ServicePlan, stopId: string): string {
  const stop = plan.stops.find((s) => s.id === stopId);
  if (!stop) return stopId;
  const station =
    stop.parent && plan.stations.find((s) => s.id === stop.parent);
  const name = station ? station.name : stop.name;
  return (busStopLabel(name) ?? name.split("@")[0]!.trim()).replace(
    /\s+Station$/i,
    "",
  );
}

export interface SharedStretch {
  groups: DepartureGroup[];
  /** The last stop every group in it serves next, in order. */
  toStopId: string;
  departures: Departure[];
}

/** Shared stretches need at least this many stops in common after this one. */
const MIN_SHARED_STOPS = 2;

/**
 * Groups that run the same way from here: the same next stops, in order, for at least a couple of
 * stops (e.g. both Expo Line branches to Columbia, or the R5 and 14 along Hastings to Renfrew).
 * Each stretch runs to where they split. Stations are compared by station, not platform.
 */
export function sharedStretches(
  plan: ServicePlan,
  groups: readonly DepartureGroup[],
): SharedStretch[] {
  const keyOf = (stopIndex: number) => {
    const s = plan.stops[stopIndex]!;
    return s.parent ?? s.id;
  };
  // Each group's onward stops, from its soonest departure's pattern.
  const onward = groups.map((g) => {
    const d = g.departures[0]!;
    const p = plan.patterns[d.pattern]!;
    return p.stops.slice(d.index + 1).map((si) => ({
      key: keyOf(si),
      id: plan.stops[si]!.id,
    }));
  });
  const byNext = new Map<string, number[]>();
  onward.forEach((o, i) => {
    if (!o.length) return;
    const k = o[0]!.key;
    byNext.set(k, [...(byNext.get(k) ?? []), i]);
  });
  const out: SharedStretch[] = [];
  for (const members of byNext.values()) {
    if (members.length < 2) continue;
    let n = 0;
    for (;;) {
      const k = onward[members[0]!]![n]?.key;
      if (!k || !members.every((m) => onward[m]![n]?.key === k)) break;
      n++;
    }
    if (n < MIN_SHARED_STOPS) continue;
    const gs = members.map((m) => groups[m]!);
    out.push({
      groups: gs,
      toStopId: onward[members[0]!]![n - 1]!.id,
      departures: gs.flatMap((g) => g.departures).sort((a, b) => a.t - b.t),
    });
  }
  return out;
}
