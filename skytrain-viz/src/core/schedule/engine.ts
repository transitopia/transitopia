// Schedule-based vehicle positions: a pure function of (plan, service date, time). This is the
// "estimated" layer for every mode; SkyTrain will switch to track-level movements (PLAN.md §4.4),
// and buses overlay real-time observations on top (§4.5).

import { bearingDeg, cumulativeLengths, pointAlong, type LonLat } from '../geo.ts';
import { indexCalendar } from '../gtfs/calendar.ts';
import { serviceDayStart } from '../time.ts';
import type { PlanPattern, PlanRoute, PlanStop, PlanTrip, ServicePlan } from '../plan/types.ts';
import {
  distanceAt,
  kinematicsFor,
  minLegTime,
  solveLeg,
  speedAt,
  type Kinematics,
  type KinematicsConfig,
  type LegProfile,
} from '../movement/kinematics.ts';

export type Provenance = 'observed' | 'interpolated' | 'estimated';
export type VehicleStatus = 'moving' | 'dwell' | 'layover' | 'turnback' | 'pullout' | 'pullin';

export interface VehicleState {
  /** Stable across consecutive trips of the same vehicle, where known. */
  id: string;
  routeKey: string;
  mode: PlanRoute['mode'];
  tripId: string;
  headsign: string;
  lon: number;
  lat: number;
  /** Degrees clockwise from north. */
  bearing: number;
  /** m/s, where known. */
  speed?: number;
  status: VehicleStatus;
  /** Stop the vehicle is at (dwell/layover) or heading to (moving). */
  stopName?: string;
  provenance: Provenance;
  source: string;
  serviceDate: string;
  /** Real-time vehicle label (e.g. bus fleet number), when observed. */
  label?: string;
  /** Seconds late (+) or early (−), when known. */
  delay?: number;
  /** Epoch ms of the real-time fix this position is based on (observed/interpolated only). */
  observedAt?: number;
  /** Inferred physical train run (SkyTrain), e.g. "expo-012". */
  runId?: string;
  /** Tail-to-head polyline along the track, for drawing trains around curves. */
  shape?: [number, number][];
  /** Position on the track graph (track-level playback only). */
  track?: { seg: string; offset: number };
  /** Observed consist (corrections), e.g. { type: 'Mk III', cars: 4 } or { name: 'Burrard Pacific Breeze' }. */
  consist?: { name?: string; type?: string; cars?: number; carNumbers?: string[] };
  length: number;
  width: number;
}

/** Layover at a terminus is shown only if the vehicle's next trip starts within this many seconds. */
const MAX_LAYOVER_S = 45 * 60;

export interface PreparedTrip {
  /** The same vehicle's next trip, when it lays over for it at this trip's last stop. */
  next?: PreparedTrip;
  trip: PlanTrip;
  pattern: PlanPattern;
  route: PlanRoute;
  kin: Kinematics;
  vehicleId: string;
  /** Effective arrival/departure (absolute service seconds), after modelled dwell is carved out. */
  arr: Float64Array;
  dep: Float64Array;
  /** Last time this trip's vehicle is shown (includes layover before the next trip in its block). */
  visibleUntil: number;
  legs: (LegProfile | undefined)[];
}

export interface PreparedPlan {
  plan: ServicePlan;
  routes: Map<string, PlanRoute>;
  tripIndex: Map<string, PreparedTrip>;
  stopById: Map<string, PlanStop>;
  shapeCum: Map<string, Float64Array>;
  servicesOn: (date: string) => Set<string>;
  /** Per service_id, trips sorted by start time. */
  tripsByService: Map<string, PreparedTrip[]>;
  /** Longest visible span of any trip per service, for bounding the search window. */
  maxSpanByService: Map<string, number>;
}

export function preparePlan(plan: ServicePlan, kinCfg: KinematicsConfig): PreparedPlan {
  const routes = new Map(plan.routes.map((r) => [r.key, r]));
  const shapeCum = new Map<string, Float64Array>();
  for (const [id, coords] of Object.entries(plan.shapes)) shapeCum.set(id, cumulativeLengths(coords));
  const tripsByService = new Map<string, PreparedTrip[]>();
  const maxSpanByService = new Map<string, number>();

  for (const trip of plan.trips) {
    const pattern = plan.patterns[trip.pattern]!;
    const route = routes.get(pattern.route)!;
    const kin = kinematicsFor(kinCfg, route.mode, route.key);
    const n = trip.arr.length;
    const arr = new Float64Array(n);
    const dep = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = trip.start + trip.arr[i]!;
      const d = trip.start + (trip.dep ?? trip.arr)[i]!;
      // Where the schedule has no dwell, centre a modelled dwell on the scheduled time.
      const half = d - a < kin.dwell ? (kin.dwell - (d - a)) / 2 : 0;
      arr[i] = i === 0 ? a : a - half;
      dep[i] = i === n - 1 ? d : d + half;
    }
    if (kin.profile === 'trapezoid' && n > 2) retime(trip, pattern.dist, kin, arr, dep);
    // Keep legs non-negative if dwell carving over-ran a very short scheduled hop.
    for (let i = 1; i < n; i++) {
      if (arr[i]! < dep[i - 1]!) {
        const mid = (arr[i]! + dep[i - 1]!) / 2;
        arr[i] = mid;
        dep[i - 1] = mid;
      }
      if (dep[i]! < arr[i]!) dep[i] = arr[i]!;
    }
    const prepared: PreparedTrip = {
      trip,
      pattern,
      route,
      kin,
      vehicleId: trip.block ? `${route.key}:${trip.service}:${trip.block}` : `${route.key}:trip:${trip.id}`,
      arr,
      dep,
      visibleUntil: arr[n - 1]!,
      legs: new Array(n - 1),
    };
    let list = tripsByService.get(trip.service);
    if (!list) tripsByService.set(trip.service, (list = []));
    list.push(prepared);
  }

  for (const [service, list] of tripsByService) {
    list.sort((x, y) => x.trip.start - y.trip.start);
    // Layover: hold the vehicle at its last stop until its block's next trip departs from there.
    const byBlock = new Map<string, PreparedTrip[]>();
    for (const t of list) {
      if (!t.trip.block) continue;
      let b = byBlock.get(t.vehicleId);
      if (!b) byBlock.set(t.vehicleId, (b = []));
      b.push(t);
    }
    for (const b of byBlock.values()) {
      for (let i = 0; i + 1 < b.length; i++) {
        const cur = b[i]!;
        const next = b[i + 1]!;
        const lastStop = plan.stops[cur.pattern.stops[cur.pattern.stops.length - 1]!]!;
        const firstStop = plan.stops[next.pattern.stops[0]!]!;
        const gap = next.dep[0]! - cur.visibleUntil;
        if (gap >= 0 && gap <= MAX_LAYOVER_S && sameStation(lastStop, firstStop)) {
          cur.visibleUntil = next.trip.start;
          cur.next = next;
        }
      }
    }
    let maxSpan = 0;
    for (const t of list) maxSpan = Math.max(maxSpan, t.visibleUntil - t.trip.start);
    maxSpanByService.set(service, maxSpan);
  }

  const tripIndex = new Map<string, PreparedTrip>();
  for (const list of tripsByService.values()) for (const t of list) tripIndex.set(t.trip.id, t);
  const stopById = new Map(plan.stops.map((s) => [s.id, s]));
  return {
    plan,
    routes,
    tripIndex,
    stopById,
    shapeCum,
    servicesOn: indexCalendar(plan.calendar),
    tripsByService,
    maxSpanByService,
  };
}

/** GTFS rail times are rounded to the minute; retimed stops stay within this of the timetable (s). */
const RETIME_TOLERANCE_S = 45;

/**
 * Re-time a trip within its fixed first departure and last arrival so each hop gets time in
 * proportion to its physical minimum (distance, acceleration, top speed) plus modelled dwell.
 * Minute-rounded GTFS times otherwise make some hops impossibly short and others slack. Each stop
 * stays within RETIME_TOLERANCE_S of its timetabled time. Mutates arr/dep.
 */
function retime(trip: PlanTrip, dist: number[], kin: Kinematics, arr: Float64Array, dep: Float64Array): void {
  const n = arr.length;
  const sched = (i: number) => trip.start + (trip.arr[i]! + (trip.dep ?? trip.arr)[i]!) / 2;
  const dwell = (i: number) => (i === 0 || i === n - 1 ? 0 : Math.max(kin.dwell, (trip.dep ?? trip.arr)[i]! - trip.arr[i]!));
  const move: number[] = [];
  for (let i = 0; i + 1 < n; i++) move.push(minLegTime(Math.max(0, dist[i + 1]! - dist[i]!), kin));
  const t0 = dep[0]!;
  let need = 0;
  for (let i = 0; i + 1 < n; i++) need += move[i]! + (i + 1 < n - 1 ? dwell(i + 1) : 0);
  if (need <= 0) return;
  // The final arrival is minute-rounded too: let it slip a little rather than race the last hop.
  arr[n - 1] = Math.max(arr[n - 1]!, Math.min(arr[n - 1]! + RETIME_TOLERANCE_S / 1.5, t0 + need));
  dep[n - 1] = Math.max(dep[n - 1]!, arr[n - 1]!);
  const total = arr[n - 1]! - t0;
  const k = total / need;
  let t = t0;
  for (let i = 1; i < n - 1; i++) {
    t += move[i - 1]! * k;
    const d = dwell(i) * k;
    // Keep the dwell's centre near the timetabled time.
    const centre = Math.min(sched(i) + RETIME_TOLERANCE_S, Math.max(sched(i) - RETIME_TOLERANCE_S, t + d / 2));
    arr[i] = centre - d / 2;
    dep[i] = centre + d / 2;
    t = dep[i]!;
  }
  // Tolerance clamps can squeeze later hops: walk backwards pulling stops earlier (within
  // tolerance) until each hop has at least its (proportionally scaled) minimum time.
  const kk = Math.min(1, k);
  for (let i = n - 2; i >= 1; i--) {
    const latestDep = arr[i + 1]! - move[i]! * kk;
    if (dep[i]! <= latestDep) continue;
    const floor = sched(i) - RETIME_TOLERANCE_S - (dep[i]! - arr[i]!) / 2;
    const shift = Math.min(dep[i]! - latestDep, Math.max(0, arr[i]! - Math.max(floor, dep[i - 1]!)));
    arr[i] = arr[i]! - shift;
    dep[i] = dep[i]! - shift;
  }
  // Last resort for the final hop: arrive a little later.
  const lastNeed = dep[n - 2]! + move[n - 2]! * kk;
  if (arr[n - 1]! < lastNeed) {
    arr[n - 1] = Math.min(lastNeed, arr[n - 1]! + RETIME_TOLERANCE_S / 1.5);
    dep[n - 1] = Math.max(dep[n - 1]!, arr[n - 1]!);
  }
}

function sameStation(a: PlanStop, b: PlanStop): boolean {
  return a.id === b.id || (a.parent !== undefined && a.parent === b.parent) || a.name === b.name;
}

/** First index in a start-sorted list with start >= t. */
function lowerBound(list: PreparedTrip[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.trip.start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface ScheduleQuery {
  serviceDate: string;
  /** Seconds since the service day's start (may exceed 86400 for after-midnight service). */
  sec: number;
  routes?: Set<string>;
}

/** All scheduled vehicles visible at the given service-day time. */
/** Observation-based adjustments for timetable vehicles (see reconcileScheduled). */
export interface ScheduleCorrections {
  /**
   * trip_id → time anchors (scheduled service seconds → shift), sorted by `sched`. The shift is
   * linear between anchors and constant beyond them, so a vessel that leaves late and makes up time
   * crossing is late by less on arrival.
   */
  trips: Map<string, { anchors: { sched: number; shift: number }[]; observed: { t: number; source: string }[] }>;
  cancelled: Set<string>;
  consists: Map<string, NonNullable<VehicleState['consist']>>;
}

const specialCache = new WeakMap<ScheduleCorrections, Set<PreparedTrip>>();
/** Trips drawn by the corrected pass: corrected or cancelled, or laying over for a corrected trip. */
function specialTrips(pp: PreparedPlan, corr: ScheduleCorrections): Set<PreparedTrip> {
  let s = specialCache.get(corr);
  if (!s) {
    s = new Set();
    for (const list of pp.tripsByService.values())
      for (const t of list) if (corr.trips.has(t.trip.id) || corr.cancelled.has(t.trip.id) || (t.next && corr.trips.has(t.next.trip.id))) s.add(t);
    specialCache.set(corr, s);
  }
  return s;
}

type Anchors = { sched: number; shift: number }[];

/** Shift (s) at scheduled time `s`. */
export function shiftAt(anchors: Anchors | undefined, s: number): number {
  if (!anchors?.length) return 0;
  if (s <= anchors[0]!.sched) return anchors[0]!.shift;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    if (s <= b.sched) return a.shift + ((b.shift - a.shift) * (s - a.sched)) / (b.sched - a.sched);
  }
  return anchors[anchors.length - 1]!.shift;
}

/** Scheduled time whose corrected time is `real` (inverse of s ↦ s + shiftAt(s)). */
export function schedAt(anchors: Anchors | undefined, real: number): number {
  if (!anchors?.length) return real;
  const first = anchors[0]!;
  if (real <= first.sched + first.shift) return real - first.shift;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    const ra = a.sched + a.shift;
    const rb = b.sched + b.shift;
    if (real <= rb) return rb > ra ? a.sched + ((b.sched - a.sched) * (real - ra)) / (rb - ra) : b.sched;
  }
  const last = anchors[anchors.length - 1]!;
  return real - last.shift;
}

/** Positions within this of an observation count as observed (s). */
const OBSERVED_S = 90;

export function scheduledVehicles(pp: PreparedPlan, q: ScheduleQuery, corr?: ScheduleCorrections): VehicleState[] {
  const out: VehicleState[] = [];
  // A trip is handled separately when it, or the trip it lays over for, is corrected.
  const special = corr ? specialTrips(pp, corr) : new Set<PreparedTrip>();
  for (const service of pp.servicesOn(q.serviceDate)) {
    const list = pp.tripsByService.get(service);
    if (!list) continue;
    const span = pp.maxSpanByService.get(service) ?? 0;
    const hi = lowerBound(list, q.sec + 1e-9);
    for (let i = lowerBound(list, q.sec - span); i < hi; i++) {
      const t = list[i]!;
      if (q.sec > t.visibleUntil) continue;
      if (q.routes && !q.routes.has(t.route.key)) continue;
      if (special.has(t)) continue;
      const v = positionOnTrip(pp, t, q.sec, q.serviceDate);
      const consist = corr?.consists.get(t.vehicleId);
      if (consist) v.consist = consist;
      out.push(v);
    }
    if (!corr) continue;
    for (const t of special) {
      if (t.trip.service !== service || corr.cancelled.has(t.trip.id) || (q.routes && !q.routes.has(t.route.key))) continue;
      const c = corr.trips.get(t.trip.id);
      const lastArr = t.arr[t.arr.length - 1]!;
      const startShift = shiftAt(c?.anchors, t.trip.start);
      const endShift = shiftAt(c?.anchors, lastArr);
      // Real-time window: warped trip, then (if chained) layover until the next trip's corrected start.
      const nextShift = t.next ? shiftAt(corr.trips.get(t.next.trip.id)?.anchors, t.next.trip.start) : 0;
      const until = t.next ? Math.max(lastArr + endShift, t.next.trip.start + nextShift) : Math.max(lastArr + endShift, t.visibleUntil + endShift);
      if (q.sec < t.trip.start + startShift || q.sec > until) continue;
      const sched = q.sec > lastArr + endShift ? lastArr : schedAt(c?.anchors, q.sec);
      const shift = shiftAt(c?.anchors, sched);
      const v = positionOnTrip(pp, t, sched, q.serviceDate);
      const obs = c?.observed.find((o) => Math.abs(o.t - q.sec) <= OBSERVED_S);
      const nextObs = t.next ? corr.trips.get(t.next.trip.id)?.observed.find((o) => Math.abs(o.t - q.sec) <= OBSERVED_S) : undefined;
      const seen = obs ?? nextObs;
      if (seen || shift !== 0 || nextShift !== 0) {
        v.provenance = seen ? 'observed' : 'interpolated';
        const sources = [...new Set([...(c?.observed ?? []), ...(t.next ? (corr.trips.get(t.next.trip.id)?.observed ?? []) : [])].map((o) => o.source))];
        v.source = `${sources.join(', ') || 'observation'} + ${v.source}`;
        if (seen) v.observedAt = serviceDayStart(q.serviceDate) + seen.t * 1000;
        if (shift !== 0 && q.sec <= lastArr + endShift) v.delay = Math.round(shift);
      }
      const consist = corr.consists.get(t.vehicleId);
      if (consist) v.consist = consist;
      out.push(v);
    }
  }
  return out;
}

function positionOnTrip(pp: PreparedPlan, t: PreparedTrip, sec: number, serviceDate: string): VehicleState {
  const { pattern, arr, dep, kin } = t;
  const coords = pp.plan.shapes[pattern.shape] as LonLat[];
  const cum = pp.shapeCum.get(pattern.shape)!;
  const n = arr.length;
  let d: number;
  let status: VehicleStatus;
  let stopIdx: number;
  let speed = 0;

  if (sec >= arr[n - 1]!) {
    d = pattern.dist[n - 1]!;
    status = 'layover';
    stopIdx = n - 1;
  } else {
    // Last stop whose arrival is <= sec.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid]! <= sec) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    if (sec <= dep[i]!) {
      d = pattern.dist[i]!;
      status = 'dwell';
      stopIdx = i;
    } else {
      const leg = (t.legs[i] ??= solveLeg(pattern.dist[i + 1]! - pattern.dist[i]!, arr[i + 1]! - dep[i]!, kin));
      const tt = sec - dep[i]!;
      d = pattern.dist[i]! + distanceAt(leg, tt);
      speed = speedAt(leg, tt);
      // Schedule slack is held at the origin, which reads as a longer dwell.
      const holding = tt < leg.hold;
      status = holding ? 'dwell' : 'moving';
      stopIdx = holding ? i : i + 1;
    }
  }

  const p = pointAlong(coords, cum, d);
  // Bearing from a short look-ahead gives smoother headings than the raw segment bearing.
  const ahead = pointAlong(coords, cum, Math.min(cum[cum.length - 1]!, d + 10));
  const behind = pointAlong(coords, cum, Math.max(0, d - 10));
  const bearing = ahead.lon === behind.lon && ahead.lat === behind.lat ? p.bearing : bearingDeg([behind.lon, behind.lat], [ahead.lon, ahead.lat]);
  const stop = pp.plan.stops[pattern.stops[stopIdx]!];
  return {
    id: t.vehicleId,
    routeKey: t.route.key,
    mode: t.route.mode,
    tripId: t.trip.id,
    headsign: t.trip.headsign,
    lon: p.lon,
    lat: p.lat,
    bearing,
    speed,
    status,
    stopName: stop?.name,
    provenance: 'estimated',
    source: `schedule ${pp.plan.feedVersion}`,
    serviceDate,
    length: kin.length,
    width: kin.width,
  };
}
