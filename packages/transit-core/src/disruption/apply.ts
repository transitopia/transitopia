// Apply disruptions to one service date's plan (docs/skytrain-viz-PLAN.md §4.11, M8.3): reroute trips onto the track
// that stays open, close the other, thin the service. The result is re-inferred and dispatched like
// any other date, so single-track working, turnbacks and knock-on delays come from the simulation.
// Pure: (plan, graph, platforms, disruptions, date) → modified plan + closures.

import type { Dir, TrackGraph, TrackPos } from "../infra/graph.ts";
import { routePattern } from "../infra/patterns.ts";
import type { PlatformAssignment } from "../infra/platforms.ts";
import type { Closure } from "../movement/build.ts";
import type { PlanPattern, PlanTrip, ServicePlan } from "../plan/types.ts";
import { serviceDayStart } from "../time.ts";
import type { Disruption } from "./types.ts";

export interface DisruptionNotice {
  id: string;
  lines: string[];
  /** Service-day seconds. */
  from: number;
  to: number;
  text: string;
  source: string;
}

export interface DisruptedDay {
  plan: ServicePlan;
  patternPositions: Map<number, Map<number, TrackPos>>;
  closures: Closure[];
  notices: DisruptionNotice[];
  /** Trips dropped by reduced service. */
  cancelled: string[];
  /** Things that couldn't be applied (unknown stations, no platform on the open track, …). */
  problems: string[];
}

/** How far to follow the open track from the kept platform, each way (m). */
const KEPT_TRACK_M = 30_000;
/** Service on a service day runs from about 04:00 to past midnight (service times beyond 24:00). */
const SERVICE_FROM_S = 4 * 3600;
const SERVICE_UNTIL_S = 30 * 3600;

/** A disruption's active periods on a service date, as service-day seconds. */
export function periodsOn(d: Disruption, date: string): [number, number][] {
  const day = serviceDayStart(date);
  const out: [number, number][] = [];
  for (const p of d.active) {
    const from = (Date.parse(p.from) - day) / 1000;
    const until = (Date.parse(p.until) - day) / 1000;
    // Only periods overlapping the day's service count (an alert ending at 04:00 is the night before's).
    if (until > SERVICE_FROM_S && from < SERVICE_UNTIL_S)
      out.push([Math.max(0, from), until]);
  }
  return out;
}

export interface ApplyInput {
  plan: ServicePlan;
  graph: TrackGraph;
  platforms: Map<string, PlatformAssignment>;
  patternPositions?: Map<number, Map<number, TrackPos>>;
  /** Active rail service ids on the date. */
  services: Set<string>;
  date: string;
  disruptions: Disruption[];
  /** Through-service headway for single-tracked lines when a disruption doesn't give one (s). */
  singleTrackHeadwayS?: number;
}

export function applyDisruptions(input: ApplyInput): DisruptedDay {
  const { graph: g, platforms, services, date } = input;
  const plan: ServicePlan = {
    ...input.plan,
    patterns: [...input.plan.patterns],
    trips: [...input.plan.trips],
  };
  const patternPositions = new Map(input.patternPositions ?? []);
  const out: DisruptedDay = {
    plan,
    patternPositions,
    closures: [],
    notices: [],
    cancelled: [],
    problems: [],
  };
  const stations = plan.stations;
  const stationOf = (si: number) =>
    plan.stops[si]!.parent ?? plan.stops[si]!.name.replace(/\s*@.*$/, "");
  const resolveStation = (x: string) =>
    stations.find((s) => s.id === x || s.name === x)?.id
    ?? stations.find((s) => s.name.toLowerCase() === x.toLowerCase())?.id;
  const tripEnd = (t: PlanTrip) => t.start + t.arr[t.arr.length - 1]!;

  for (const d of input.disruptions) {
    if (d.status === "draft") continue;
    const periods = periodsOn(d, date);
    if (!periods.length) continue;
    const from = Math.min(...periods.map((p) => p[0]));
    const to = Math.max(...periods.map((p) => p[1]));
    const inPeriod = (t: PlanTrip) =>
      periods.some(([a, b]) => t.start < b && tripEnd(t) > a);
    const lines = new Set<string>();

    for (const st of d.singleTrack ?? []) {
      lines.add(st.line);
      const A = resolveStation(st.between[0]);
      const B = resolveStation(st.between[1]);
      const keepStop = plan.stops.find(
        (s) => s.id === st.keep || s.name === st.keep,
      );
      const keepPos = keepStop && platforms.get(keepStop.id)?.pos;
      if (!A || !B || !keepPos) {
        out.problems.push(
          `${d.id}: unknown ${
            !A ? st.between[0]
            : !B ? st.between[1]
            : st.keep
          }`,
        );
        continue;
      }
      const kept = openTrack(g, keepPos);
      // Stations in the section: A, B and every station between them on the line's patterns.
      const section = new Set([A, B]);
      const linePatterns = plan.patterns.filter((p) => p.route === st.line);
      for (const p of linePatterns) {
        const sts = p.stops.map(stationOf);
        const ia = sts.indexOf(A);
        const ib = sts.indexOf(B);
        if (ia >= 0 && ib >= 0)
          for (let i = Math.min(ia, ib); i <= Math.max(ia, ib); i++)
            section.add(sts[i]!);
      }
      // Stations whose stops stay put: the ends, unless they're single-track too.
      const ends = new Set(st.pinEnds ? [] : [A, B]);
      // Closed: track the section's hops use that isn't the open track or an end station's platform.
      const endSegs = new Set<string>();
      for (const s of plan.stops)
        if (s.parent && ends.has(s.parent)) {
          const a = platforms.get(s.id);
          if (a) endSegs.add(a.pos.seg);
        }
      const closed = new Set<string>();
      const affected: PlanPattern[] = [];
      for (const p of linePatterns) {
        const sts = p.stops.map(stationOf);
        if (!sts.some((s) => section.has(s))) continue;
        const r = routePattern(g, plan, platforms, p, input.patternPositions);
        let touches = false;
        r.hops.forEach((h, i) => {
          if (!h || !section.has(sts[i]!) || !section.has(sts[i + 1]!)) return;
          touches = true;
          for (const piece of h.pieces)
            if (!kept.has(piece.seg) && !endSegs.has(piece.seg))
              closed.add(piece.seg);
        });
        if (touches || sts.some((s) => section.has(s) && !ends.has(s)))
          affected.push(p);
        // With pinned ends, hops into and out of the section run on the open track too.
        if (st.pinEnds)
          r.hops.forEach((h, i) => {
            if (!h || section.has(sts[i]!) === section.has(sts[i + 1]!)) return;
            const inside = section.has(sts[i]!) ? i : i + 1;
            const own = platforms.get(plan.stops[p.stops[inside]!]!.id)?.pos;
            if (own && !kept.has(own.seg)) closed.add(own.seg);
          });
      }
      // Clone the affected patterns with their section stops pinned to the open track.
      const clones = new Set<number>();
      const cloneOf = new Map<number, number>();
      for (const p of affected) {
        const pins = new Map(input.patternPositions?.get(p.id) ?? []);
        let ok = true;
        p.stops.forEach((si, i) => {
          const s = stationOf(si);
          if (!section.has(s)) return;
          const own = platforms.get(plan.stops[si]!.id)?.pos;
          if (own && kept.has(own.seg)) return;
          if (ends.has(s)) return; // an end station keeps its platform; the train crosses over nearby
          const onKept = plan.stops
            .map((x) => (x.parent === s ? platforms.get(x.id)?.pos : undefined))
            .find((pos) => pos && kept.has(pos.seg));
          if (onKept) pins.set(i, onKept);
          else {
            ok = false;
            out.problems.push(
              `${d.id}: no platform on the open track at ${stations.find((x) => x.id === s)?.name ?? s}`,
            );
          }
        });
        if (!ok) continue;
        const id = plan.patterns.length;
        plan.patterns.push({ ...p, id });
        patternPositions.set(id, pins);
        clones.add(id);
        cloneOf.set(p.id, id);
      }
      plan.trips = plan.trips.map((t) =>
        services.has(t.service) && cloneOf.has(t.pattern) && inPeriod(t) ?
          { ...t, pattern: cloneOf.get(t.pattern)! }
        : t,
      );
      out.closures.push({ segs: closed, from, to, patterns: clones });
    }

    // Single-tracking without a stated headway: thin the through service to the configured default.
    const defaults = (d.singleTrack ?? [])
      .filter(
        (st) =>
          input.singleTrackHeadwayS
          && !(d.headway ?? []).some((h) => h.line === st.line),
      )
      .map((st) => ({
        line: st.line,
        between: st.between,
        minS: input.singleTrackHeadwayS!,
      }));
    for (const hw of [...(d.headway ?? []), ...defaults]) {
      lines.add(hw.line);
      const section =
        hw.between ?
          new Set(
            hw.between
              .map(resolveStation)
              .filter((x): x is string => Boolean(x)),
          )
        : undefined;
      const lastKept = new Map<number, number>();
      const drop = new Set<string>();
      const candidates = plan.trips
        .filter((t) => services.has(t.service) && inPeriod(t))
        .filter((t) => {
          const p = plan.patterns[t.pattern]!;
          return (
            p.route === hw.line
            && (!section || p.stops.some((si) => section.has(stationOf(si))))
          );
        })
        .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
      for (const t of candidates) {
        const dir = plan.patterns[t.pattern]!.direction;
        const last = lastKept.get(dir);
        if (last !== undefined && t.start < last + hw.minS) drop.add(t.id);
        else lastKept.set(dir, t.start);
      }
      plan.trips = plan.trips.filter((t) => !drop.has(t.id));
      out.cancelled.push(...drop);
    }
    out.notices.push({
      id: d.id,
      lines: [...lines].sort(),
      from,
      to,
      text: d.text,
      source: d.source,
    });
  }
  return out;
}

/** The track through a platform: followed straight on both ways until it ends (segment ids). */
function openTrack(g: TrackGraph, pos: TrackPos): Set<string> {
  const segs = new Set<string>([pos.seg]);
  for (const dir of [1, -1] as Dir[]) {
    let seg = pos.seg;
    let d = dir;
    let dist = 0;
    for (let guard = 0; guard < 500 && dist < KEPT_TRACK_M; guard++) {
      const nx = g.straightest(seg, d);
      if (!nx || segs.has(nx.seg)) break;
      segs.add(nx.seg);
      dist += g.segment(nx.seg).length;
      seg = nx.seg;
      d = nx.dir;
    }
  }
  return segs;
}
