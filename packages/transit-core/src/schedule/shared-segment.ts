// Combined routes (packages/transit-core/DESIGN.md#combined-routes): the stretch a stop card's
// shared row names ("250 or 251, to 17 St"), as far back as the routes run together, so it can be
// shown and counted like a route of its own. Named by where it starts and ends alone, so a link to
// it holds on any date.

import type { LonLat } from "../geo.ts";
import { cumulativeLengths, projectOnto, sliceLine } from "../geo.ts";
import type { PlanTrip, ServicePlan } from "../plan/types.ts";
import type { ServiceDate } from "../time.ts";
import {
  bestDirection,
  DAY_HOURS,
  type Frequency,
  type ServicesOn,
  type Starts,
} from "./frequency.ts";

const HOUR = 3600;

/**
 * Which place a stop counts as, by id (a station's own id gives itself): its station, its exchange,
 * or itself. Routes leaving a station or an exchange from different bays have come together there.
 */
export type PlaceOf = (id: string) => string;

/** Places as the plan alone has them: platforms are their station's (GTFS parents). */
export function stationsOnly(plan: Pick<ServicePlan, "stops">): PlaceOf {
  const parent = new Map(plan.stops.map((s) => [s.id, s.parent ?? s.id]));
  return (id) => parent.get(id) ?? id;
}

/**
 * Where routes leaving a stop together (`sharedRuns`) came together: each member is its pattern and
 * its index at the stop, and the walk goes back while every member's previous stop is at the same
 * place (`placeOf`). Members leaving from different places start at the next stop, the first they
 * share. The start, as a combined route's end: a station's id, else a stop's (for an exchange, one
 * of its bays).
 */
export function sharedStart(
  plan: ServicePlan,
  members: readonly { pattern: number; index: number }[],
  placeOf: PlaceOf = stationsOnly(plan),
): string {
  const stopAt = (m: { pattern: number }, i: number) =>
    plan.stops[plan.patterns[m.pattern]!.stops[i]!]!.id;
  const same = (back: number) => {
    if (members.some((m) => m.index - back < 0)) return false;
    const k = placeOf(stopAt(members[0]!, members[0]!.index - back));
    return members.every((m) => placeOf(stopAt(m, m.index - back)) === k);
  };
  let back = 0;
  if (!same(0)) back = -1;
  else while (same(back + 1)) back++;
  const stop = stopAt(members[0]!, members[0]!.index - back);
  const place = placeOf(stop);
  return plan.stations.some((s) => s.id === place) ? place : stop;
}

/** A combined route: the patterns running from one place to another through the same places. */
export interface SharedSegment {
  /** Where it starts and ends, as given: a station's id or a stop's. */
  from: string;
  to: string;
  /** Each pattern along it, with its indices at the start and the end. */
  patterns: { pattern: number; from: number; to: number }[];
  /** Their routes, in the plan's order. */
  routes: string[];
}

/**
 * The combined route from `from` to `to` (a station's id or a stop's, each standing for its place,
 * `placeOf`): every pattern serving both, in that order, with the places between that the most
 * routes share (the routes a shared row combined, and any other running the whole stretch with
 * them: a night bus). Undefined when no pattern does, or both ends are one place.
 */
export function sharedSegment(
  plan: ServicePlan,
  from: string,
  to: string,
  placeOf: PlaceOf = stationsOnly(plan),
): SharedSegment | undefined {
  const start = placeOf(from);
  const end = placeOf(to);
  if (start === end) return undefined;
  const bySequence = new Map<string, SharedSegment["patterns"]>();
  for (const p of plan.patterns) {
    const keys = p.stops.map((s) => placeOf(plan.stops[s]!.id));
    const i = keys.indexOf(start);
    const j = i < 0 ? -1 : keys.indexOf(end, i + 1);
    if (j < 0) continue;
    const seq = keys.slice(i, j + 1).join("\n");
    bySequence.set(seq, [
      ...(bySequence.get(seq) ?? []),
      { pattern: p.id, from: i, to: j },
    ]);
  }
  const routesOf = (ps: SharedSegment["patterns"]) =>
    new Set(ps.map((x) => plan.patterns[x.pattern]!.route));
  let best: SharedSegment["patterns"] | undefined;
  for (const ps of bySequence.values()) {
    const n = routesOf(ps).size;
    const m = best ? routesOf(best).size : -1;
    if (n > m || (n === m && ps.length > best!.length)) best = ps;
  }
  if (!best) return undefined;
  const routes = routesOf(best);
  return {
    from,
    to,
    patterns: best,
    routes: plan.routes.map((r) => r.key).filter((k) => routes.has(k)),
  };
}

/**
 * When each of a segment's patterns' trips typically leave its start (s after the trip starts):
 * the median of the trips given (the browser has only the shown days' trips), 0 without any.
 */
export function startOffsets(
  segment: SharedSegment,
  trips: Iterable<PlanTrip>,
): number[] {
  const times = segment.patterns.map((): number[] => []);
  const at = new Map(segment.patterns.map((p, i) => [p.pattern, i]));
  for (const t of trips) {
    const i = at.get(t.pattern);
    if (i === undefined) continue;
    const v = (t.dep ?? t.arr)[segment.patterns[i]!.from];
    if (v !== undefined) times[i]!.push(v);
  }
  return times.map((l) => {
    if (!l.length) return 0;
    l.sort((a, b) => a - b);
    return l[l.length >> 1]!;
  });
}

/**
 * The segment's departures from its start, as frequency sources (`Starts`): each pattern's trips'
 * start times shifted by its `startOffsets`. Merged, not summed (packages/transit-core/DESIGN.md#frequency).
 */
export function segmentStarts(
  segment: SharedSegment,
  starts: readonly Record<string, number[]>[],
  offsets: readonly number[],
): Starts[] {
  return segment.patterns.map((p, i) => ({
    byService: starts[p.pattern]!,
    offset: offsets[i]!,
  }));
}

/** How often the segment's buses leave its start in the `seconds` from `from` on a date. */
export function segmentFrequency(
  servicesOn: ServicesOn,
  sources: readonly Starts[],
  date: ServiceDate,
  from: number,
  seconds: number,
): Frequency | undefined {
  return bestDirection(servicesOn, [sources], date, from, seconds);
}

/** How often the segment's buses leave its start in each hour of DAY_HOURS on a date. */
export function segmentHourly(
  servicesOn: ServicesOn,
  sources: readonly Starts[],
  date: ServiceDate,
): (Frequency | undefined)[] {
  return DAY_HOURS.map((h) =>
    segmentFrequency(servicesOn, sources, date, h * HOUR, HOUR),
  );
}

/** The stretch of each pattern's shape the segment covers: [from, to] in metres along it. */
export function segmentRanges(
  plan: ServicePlan,
  segment: SharedSegment,
): Map<number, [number, number]> {
  return new Map(
    segment.patterns.map((p) => {
      const { dist } = plan.patterns[p.pattern]!;
      return [p.pattern, [dist[p.from]!, dist[p.to]!]];
    }),
  );
}

/** The segment's lines: each pattern's shape between its start and end (for fitting the map to it). */
export function segmentLines(
  plan: ServicePlan,
  segment: SharedSegment,
  cumOf: (shape: string) => Float64Array | undefined,
): LonLat[][] {
  const ranges = segmentRanges(plan, segment);
  return segment.patterns.map((p) => {
    const pattern = plan.patterns[p.pattern]!;
    const coords = (plan.shapes[pattern.shape] ?? []) as LonLat[];
    const cum = cumOf(pattern.shape) ?? cumulativeLengths(coords);
    const [a, b] = ranges.get(p.pattern)!;
    return sliceLine(coords, a, b, cum);
  });
}

/**
 * Whether a vehicle at `at` on one of the segment's patterns is on the segment: its position
 * projected onto the pattern's shape is between the start and the end (a few metres either side).
 */
export function onSegment(
  plan: ServicePlan,
  ranges: ReadonlyMap<number, [number, number]>,
  pattern: number,
  at: LonLat,
  cumOf: (shape: string) => Float64Array | undefined,
): boolean {
  const range = ranges.get(pattern);
  if (!range) return false;
  const p = plan.patterns[pattern]!;
  const coords = (plan.shapes[p.shape] ?? []) as LonLat[];
  if (coords.length < 2) return false;
  const cum = cumOf(p.shape) ?? cumulativeLengths(coords);
  const { along } = projectOnto(coords, cum, at);
  return (
    along >= range[0] - ON_SEGMENT_SLACK_M
    && along <= range[1] + ON_SEGMENT_SLACK_M
  );
}

/** How far before its start or past its end a vehicle still counts as on a segment (m): it's at the stop. */
const ON_SEGMENT_SLACK_M = 20;

/**
 * A corridor is drawn whole, so one the segment covers only part of is drawn with it when the
 * segment runs along at least this much of it (m), or half of it. A segment usually starts partway
 * along a corridor: where its routes' stops first match, not where their roads join (UVic's Ring Rd,
 * one corridor from the exchange, is shared from its second stop on). A presentation choice.
 */
const MIN_OVERLAP_M = 100;

/**
 * The corridors a segment runs along (`PlanCorridorRefs`, one set: detailed or overview): those
 * it covers at least half of, or MIN_OVERLAP_M of, along one of its patterns. A corridor's length
 * along a pattern is up to where the pattern enters its next corridor (or its shape ends).
 */
export function segmentCorridors(
  plan: ServicePlan,
  segment: SharedSegment,
  refs: readonly (readonly [number, 1 | -1, number])[][],
  shapeLength: (shape: string) => number,
): Set<number> {
  const ranges = segmentRanges(plan, segment);
  // Per pattern of the segment: [corridor, where it enters] along it, in order.
  const entries = new Map<number, [number, number][]>();
  refs.forEach((rs, corridor) => {
    for (const [p, , along] of rs) {
      if (!ranges.has(p)) continue;
      let list = entries.get(p);
      if (!list) entries.set(p, (list = []));
      list.push([corridor, along]);
    }
  });
  const out = new Set<number>();
  for (const [p, list] of entries) {
    list.sort((a, b) => a[1] - b[1]);
    const [a, b] = ranges.get(p)!;
    const end = shapeLength(plan.patterns[p]!.shape);
    list.forEach(([corridor, along], i) => {
      const to = list[i + 1]?.[1] ?? end;
      const overlap = Math.min(to, b) - Math.max(along, a);
      if (overlap >= Math.min(MIN_OVERLAP_M, (to - along) / 2) && overlap > 0)
        out.add(corridor);
    });
  }
  return out;
}

/** The plan's stops along a segment (stop indices), its start and end included. */
export function segmentStops(
  plan: ServicePlan,
  segment: SharedSegment,
): Set<number> {
  const out = new Set<number>();
  for (const p of segment.patterns)
    for (const s of plan.patterns[p.pattern]!.stops.slice(p.from, p.to + 1))
      out.add(s);
  return out;
}
