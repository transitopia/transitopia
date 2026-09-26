// Schedule-based vehicle positions: a pure function of (plan, service date, time). This is the
// "estimated" layer for every mode; SkyTrain will switch to track-level movements (PLAN.md §4.4),
// and buses overlay real-time observations on top (§4.5).

import { bearingDeg, cumulativeLengths, pointAlong, type LonLat } from '../geo.ts';
import { indexCalendar } from '../gtfs/calendar.ts';
import type { PlanPattern, PlanRoute, PlanStop, PlanTrip, ServicePlan } from '../plan/types.ts';
import { distanceAt, kinematicsFor, solveLeg, speedAt, type Kinematics, type KinematicsConfig, type LegProfile } from '../movement/kinematics.ts';

export type Provenance = 'observed' | 'interpolated' | 'estimated';
export type VehicleStatus = 'moving' | 'dwell' | 'layover';

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
  length: number;
  width: number;
}

/** Layover at a terminus is shown only if the vehicle's next trip starts within this many seconds. */
const MAX_LAYOVER_S = 45 * 60;

export interface PreparedTrip {
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
        if (gap >= 0 && gap <= MAX_LAYOVER_S && sameStation(lastStop, firstStop)) cur.visibleUntil = next.trip.start;
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
export function scheduledVehicles(pp: PreparedPlan, q: ScheduleQuery): VehicleState[] {
  const out: VehicleState[] = [];
  for (const service of pp.servicesOn(q.serviceDate)) {
    const list = pp.tripsByService.get(service);
    if (!list) continue;
    const span = pp.maxSpanByService.get(service) ?? 0;
    const hi = lowerBound(list, q.sec + 1e-9);
    for (let i = lowerBound(list, q.sec - span); i < hi; i++) {
      const t = list[i]!;
      if (q.sec > t.visibleUntil) continue;
      if (q.routes && !q.routes.has(t.route.key)) continue;
      out.push(positionOnTrip(pp, t, q.sec, q.serviceDate));
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
