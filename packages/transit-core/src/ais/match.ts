// AIS fixes → schedule corrections for timetable vessels (SeaBus), packages/transit-core/DESIGN.md#seabus-ais.
//
// Each fix is matched to the trip whose berth-to-berth path it lies on and whose timetable puts
// the vessel nearest that point at that time. The fix becomes a time anchor on that trip ("the
// vessel was here at t"), so the engine draws the vessel on our lanes, shifted to agree with the
// fix, and marks positions near a fix as observed. Fixes at a berth say the vessel is docked there:
// they only move the timetable when they contradict it (still docked after departure time, or
// already docked before the scheduled arrival). A trip's lateness carries into the vessel's next
// trips, less the layover slack. Each GTFS block gets the name of the vessel matched to most of
// its fixes. Fixes that match nothing (e.g. at the layup berth) are ignored: those vessels are out
// of service. The day's berth pair (ServicePlan.ferry) comes from where vessels dock: when most
// docked fixes are at another pair's berths than the default, the whole day is drawn along that
// pair's paths. Pure: (plan, date, fixes, config) → corrections.

import {
  bearingDeg,
  distM,
  pointAlong,
  projectOnto,
  type LonLat,
} from "../geo.ts";
import { distanceAt, solveLeg } from "../movement/kinematics.ts";
import type {
  PreparedPlan,
  PreparedTrip,
  ScheduleCorrections,
} from "../schedule/engine.ts";
import type { PlanPattern } from "../plan/types.ts";
import { serviceDayStart } from "../time.ts";

export interface AisFix {
  mmsi: string;
  name?: string | undefined;
  /** Epoch ms of the fix. */
  ts: number;
  lat: number;
  lon: number;
  /** Speed over ground, knots. */
  sog?: number | undefined;
  /** Course over ground, degrees. */
  cog?: number | undefined;
}

export interface AisMatchConfig {
  /** A fix further than this from a trip's path doesn't match it (m). */
  maxOffsetM: number;
  /** A fix doesn't match a trip whose timetable is further out than this (s). */
  maxShiftS: number;
  /** At or below this speed a vessel is stationary (knots). */
  stationaryKn: number;
  /** A stationary fix within this of a path's end is docked at that berth (m). */
  dockRadiusM: number;
  /** A moving vessel's course must be within this of its path's direction (degrees). */
  courseToleranceDeg: number;
  /** Minimum turnaround at a berth; layover beyond it absorbs lateness (s). */
  minTurnaroundS: number;
  /** Carry lateness into at most this many following trips. */
  maxCarryTrips: number;
  /** A day's berth pair needs at least this many docked fixes, more than at all other pairs together. */
  pairMinFixes: number;
}

export interface AisDay {
  corrections: ScheduleCorrections;
  /** Vehicle chain (PreparedTrip.vehicleId) → the vessel that ran it. */
  vessels: Map<string, { mmsi: string; name?: string; fixes: number }>;
  /** The day's berth pair (ServicePlan.ferry), when the plan has pairs. */
  pair?: string;
  matched: number;
  unmatched: number;
}

const SOURCE = "AIS";

interface Match {
  trip: PreparedTrip;
  /** Scheduled service-day second the anchor applies to, and the shift there. */
  sched: number;
  shift: number;
  /** Only a bound (docked fixes consistent with the timetable don't anchor). */
  anchor: boolean;
}

/** Corrections for one service date's vessels on `route` from its AIS fixes. */
export function aisCorrections(
  pp: PreparedPlan,
  serviceDate: string,
  fixes: AisFix[],
  route: string,
  cfg: AisMatchConfig,
): AisDay {
  const dayStart = serviceDayStart(serviceDate);
  const trips = [...pp.servicesOn(serviceDate)]
    .flatMap((s) => pp.tripsByService.get(s) ?? [])
    .filter((t) => t.route.key === route);
  const out: AisDay = {
    corrections: {
      trips: new Map(),
      cancelled: new Set(),
      consists: new Map(),
    },
    vessels: new Map(),
    matched: 0,
    unmatched: 0,
  };
  if (!trips.length) return out;

  const ferry = pp.plan.ferry?.route === route ? pp.plan.ferry : undefined;
  if (ferry) {
    out.pair = berthPair(pp, fixes, cfg);
    if (out.pair !== ferry.default)
      out.corrections.shapes = new Map(
        Object.entries(ferry.pairs[out.pair]!.shapes).map(([id, shape]) => [
          Number(id),
          shape,
        ]),
      );
  }
  const shapeOf = (p: PlanPattern) =>
    out.corrections.shapes?.get(p.id) ?? p.shape;

  const perTrip = new Map<
    PreparedTrip,
    { anchors: Map<number, number>; observed: { t: number; source: string }[] }
  >();
  const votes = new Map<string, Map<string, { name?: string; n: number }>>();
  const sorted = [...fixes].sort((a, b) => a.ts - b.ts);
  for (const f of sorted) {
    const s = (f.ts - dayStart) / 1000;
    const m = matchFix(pp, trips, f, s, cfg, shapeOf);
    if (!m) {
      out.unmatched++;
      continue;
    }
    out.matched++;
    let e = perTrip.get(m.trip);
    if (!e) perTrip.set(m.trip, (e = { anchors: new Map(), observed: [] }));
    if (m.anchor) e.anchors.set(m.sched, m.shift);
    e.observed.push({ t: s, source: SOURCE });
    let v = votes.get(m.trip.vehicleId);
    if (!v) votes.set(m.trip.vehicleId, (v = new Map()));
    const c = v.get(f.mmsi) ?? { n: 0 };
    if (f.name) c.name = f.name;
    c.n++;
    v.set(f.mmsi, c);
  }

  // Observed trips: their anchors (a trip seen only docked on time gets a zero anchor, so it's
  // still drawn as observed).
  const corr = out.corrections;
  for (const [trip, e] of perTrip) {
    const anchors = [...e.anchors]
      .map(([sched, shift]) => ({ sched, shift }))
      .sort((a, b) => a.sched - b.sched);
    if (!anchors.length) anchors.push({ sched: trip.trip.start, shift: 0 });
    corr.trips.set(trip.trip.id, { anchors, observed: e.observed });
  }
  // Carry each observed trip's final lateness into the vessel's next unobserved trips.
  for (const [trip, e] of perTrip) {
    const anchors = corr.trips.get(trip.trip.id)!.anchors;
    let late = anchors[anchors.length - 1]!.shift;
    const lastSeen = e.observed[e.observed.length - 1]!.t;
    let cur = trip;
    for (
      let k = 0;
      k < cfg.maxCarryTrips && late > 0 && cur.next && !perTrip.has(cur.next);
      k++
    ) {
      const next: PreparedTrip = cur.next;
      late -= Math.max(
        0,
        next.trip.start - cur.arr[cur.arr.length - 1]! - cfg.minTurnaroundS,
      );
      if (late <= 0) break;
      const mins = Math.round(late / 60);
      corr.trips.set(next.trip.id, {
        anchors: [{ sched: next.trip.start, shift: late }],
        observed: [],
        estimate: `AIS (${mins > 0 ? `+${mins} min` : "late"} carried from ${fmt(lastSeen)})`,
      });
      cur = next;
    }
  }
  // Vessel names per block: the vessel with the most matched fixes.
  for (const [vehicleId, v] of votes) {
    const [mmsi, best] = [...v].sort((a, b) => b[1].n - a[1].n)[0]!;
    out.vessels.set(vehicleId, {
      mmsi,
      ...(best.name ? { name: best.name } : {}),
      fixes: best.n,
    });
    if (best.name) corr.consists.set(vehicleId, { name: best.name });
  }
  return out;
}

/** The berth pair most docked fixes were at, if clearly so; else the plan's default. */
export function berthPair(
  pp: PreparedPlan,
  fixes: AisFix[],
  cfg: AisMatchConfig,
): string {
  const ferry = pp.plan.ferry!;
  const votes = new Map<string, number>();
  for (const f of fixes) {
    if (f.sog === undefined || f.sog > cfg.stationaryKn) continue;
    let best: string | undefined;
    let bestD = cfg.dockRadiusM;
    for (const [pair, { docks }] of Object.entries(ferry.pairs)) {
      for (const dock of docks) {
        const d = distM([f.lon, f.lat], dock);
        if (d <= bestD) [best, bestD] = [pair, d];
      }
    }
    if (best) votes.set(best, (votes.get(best) ?? 0) + 1);
  }
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  for (const [pair, n] of votes)
    if (n >= cfg.pairMinFixes && n > total - n) return pair;
  return ferry.default;
}

function matchFix(
  pp: PreparedPlan,
  trips: PreparedTrip[],
  f: AisFix,
  s: number,
  cfg: AisMatchConfig,
  shapeOf: (p: PlanPattern) => string,
): Match | undefined {
  const p: LonLat = [f.lon, f.lat];
  const stationary = f.sog !== undefined && f.sog <= cfg.stationaryKn;
  let best: (Match & { cost: number }) | undefined;
  for (const trip of trips) {
    const n = trip.arr.length;
    const dep = trip.dep[0]!;
    const arr = trip.arr[n - 1]!;
    if (s < dep - cfg.maxShiftS || s > arr + cfg.maxShiftS) continue;
    const shape = shapeOf(trip.pattern);
    const coords = pp.plan.shapes[shape] as LonLat[] | undefined;
    const cum = pp.shapeCum.get(shape);
    if (!coords || !cum) continue;
    const total = cum[cum.length - 1]!;
    // Distance along the drawn shape → along the pattern (they differ for another berth pair).
    const toPattern =
      trip.pattern.dist[trip.pattern.dist.length - 1]! / Math.max(1, total);
    let m: Match | undefined;
    if (stationary && distM(p, coords[0]!) <= cfg.dockRadiusM) {
      // Docked at the origin berth: late if still there after departure time.
      m =
        s > dep ?
          { trip, sched: dep, shift: s - dep, anchor: true }
        : { trip, sched: dep, shift: 0, anchor: false };
    } else if (
      stationary
      && distM(p, coords[coords.length - 1]!) <= cfg.dockRadiusM
    ) {
      // Docked at the destination berth: early if there before the scheduled arrival. After the
      // vessel's next departure it's that trip, running late.
      if (trip.next && s > trip.next.dep[0]!) continue;
      m =
        s < arr ?
          { trip, sched: arr, shift: s - arr, anchor: true }
        : { trip, sched: arr, shift: 0, anchor: false };
    } else if (!stationary || f.sog === undefined) {
      const pr = projectOnto(coords, cum, p, 0, cfg.maxOffsetM);
      if (pr.offset > cfg.maxOffsetM || pr.along <= 0 || pr.along >= total)
        continue;
      if (
        f.cog !== undefined
        && f.sog !== undefined
        && f.sog > cfg.stationaryKn
      ) {
        const a = pointAlong(coords, cum, Math.max(0, pr.along - 20));
        const b = pointAlong(coords, cum, Math.min(total, pr.along + 20));
        const dir = bearingDeg([a.lon, a.lat], [b.lon, b.lat]);
        if (
          Math.abs(((f.cog - dir + 540) % 360) - 180) > cfg.courseToleranceDeg
        )
          continue;
      }
      const sched = schedTimeAt(trip, pr.along * toPattern);
      m = { trip, sched, shift: s - sched, anchor: true };
    }
    if (!m || Math.abs(m.shift) > cfg.maxShiftS) continue;
    // Prefer the trip the timetable agrees with most; for a docked vessel consistent with several
    // (all vessels share the berths), the arrival or departure nearest in time.
    const cost =
      Math.abs(m.shift) + (m.anchor ? 0 : Math.abs(m.sched - s) * 1e-3);
    if (!best || cost < best.cost) best = { ...m, cost };
  }
  return best;
}

/** Scheduled service-day second at which a trip's timetable puts it `along` metres along its path. */
export function schedTimeAt(trip: PreparedTrip, along: number): number {
  const d = trip.pattern.dist;
  const n = d.length;
  let i = 0;
  while (i + 1 < n - 1 && d[i + 1]! <= along) i++;
  const len = d[i + 1]! - d[i]!;
  const dur = trip.arr[i + 1]! - trip.dep[i]!;
  const leg = (trip.legs[i] ??= solveLeg(len, dur, trip.kin));
  const target = along - d[i]!;
  let lo = 0;
  let hi = dur;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (distanceAt(leg, mid) < target) lo = mid;
    else hi = mid;
  }
  return trip.dep[i]! + (lo + hi) / 2;
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
