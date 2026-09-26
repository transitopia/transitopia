// Turns a series of RT snapshots into bus positions at any instant, with provenance (PLAN.md §4.5):
//  - interpolated: between two fixes of the same vehicle ≤ maxInterpolateS apart, moved along the
//    trip's shape (not in a straight line);
//  - observed: at/after the latest fix, dead-reckoned along the shape for ≤ maxExtrapolateS;
//  - otherwise the vehicle is not shown (the caller falls back to schedule estimates when the
//    instant isn't covered by RT data at all).
// Pure given its inputs: the same snapshots and t always give the same answer.

import { cumulativeLengths, pointAlong, projectOnto, type LonLat } from '../geo.ts';
import type { PreparedPlan, VehicleState } from '../schedule/engine.ts';
import { kinematicsFor, type KinematicsConfig } from '../movement/kinematics.ts';
import type { RtSnapshot, RtVehicle } from './types.ts';
import { localDate } from '../time.ts';

export interface TimelineOptions {
  maxInterpolateS: number;
  maxExtrapolateS: number;
  /** Label for VehicleState.source, e.g. "GTFS-RT live". */
  source: string;
}

interface Obs {
  v: RtVehicle;
  /** Fetch time of the snapshot this fix came from. */
  fetchedAt: number;
  /** Distance along the trip shape (m), computed lazily; NaN when unknown. */
  along?: number;
}

interface Track {
  obs: Obs[]; // sorted by v.ts, unique ts
  /** Fetch times of snapshots that included this vehicle, sorted. */
  seenAt: number[];
}

/** Upper bound for plausible bus speed when dead-reckoning (m/s). */
const MAX_SPEED = 25;

export class RtTimeline {
  private tracks = new Map<string, Track>();
  private fetchTimes: number[] = [];
  private shapeCache = new Map<string, { coords: LonLat[]; cum: Float64Array } | null>();

  constructor(
    snapshots: RtSnapshot[],
    private pp: PreparedPlan | undefined,
    private kin: KinematicsConfig,
    private opts: TimelineOptions,
  ) {
    const sorted = [...snapshots].sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const s of sorted) {
      this.fetchTimes.push(s.fetchedAt);
      for (const v of s.vehicles) {
        let tr = this.tracks.get(v.id);
        if (!tr) this.tracks.set(v.id, (tr = { obs: [], seenAt: [] }));
        tr.seenAt.push(s.fetchedAt);
        const last = tr.obs[tr.obs.length - 1];
        if (last && last.v.ts === v.ts) continue; // unchanged fix repeated across polls
        if (last && v.ts < last.v.ts) continue; // out-of-order fix
        tr.obs.push({ v, fetchedAt: s.fetchedAt });
      }
    }
  }

  get size(): number {
    return this.fetchTimes.length;
  }

  /** Time span of the snapshots [first fetch, last fetch]. */
  span(): [number, number] | undefined {
    if (!this.fetchTimes.length) return undefined;
    return [this.fetchTimes[0]!, this.fetchTimes[this.fetchTimes.length - 1]!];
  }

  vehiclesAt(t: number, routes?: Set<string>): VehicleState[] {
    const out: VehicleState[] = [];
    // Latest snapshot fetched at or before t: vehicles absent from it have left service.
    const latestFetch = floorValue(this.fetchTimes, t);
    for (const [id, tr] of this.tracks) {
      const i = floorIndex(tr.obs, t);
      const o0 = i >= 0 ? tr.obs[i] : undefined;
      const o1 = tr.obs[i + 1];
      if (!o0) continue;
      if (routes && !routes.has(o0.v.routeKey)) continue;
      if (o1 && (o1.v.ts - o0.v.ts) / 1000 <= this.opts.maxInterpolateS) {
        out.push(this.interpolate(id, o0, o1, t));
        continue;
      }
      // No usable later fix: dead-reckon, but only while the vehicle is still being reported.
      if ((t - o0.v.ts) / 1000 > this.opts.maxExtrapolateS) continue;
      const lastSeen = floorValue(tr.seenAt, t);
      if (latestFetch !== undefined && lastSeen !== undefined && latestFetch > lastSeen) continue;
      const prev = i > 0 ? tr.obs[i - 1] : undefined;
      out.push(this.extrapolate(id, prev, o0, t));
    }
    return out;
  }

  private shape(tripId: string | undefined) {
    if (!tripId || !this.pp) return null;
    let s = this.shapeCache.get(tripId);
    if (s !== undefined) return s;
    const trip = this.pp.tripIndex.get(tripId);
    const coords = trip ? (this.pp.plan.shapes[trip.pattern.shape] as LonLat[] | undefined) : undefined;
    s = coords ? { coords, cum: this.pp.shapeCum.get(trip!.pattern.shape) ?? cumulativeLengths(coords) } : null;
    this.shapeCache.set(tripId, s);
    return s;
  }

  private alongOf(o: Obs, fromAlong = 0): number {
    if (o.along !== undefined) return o.along;
    const s = this.shape(o.v.tripId);
    if (!s) return (o.along = NaN);
    const p = projectOnto(s.coords, s.cum, [o.v.lon, o.v.lat], Math.max(0, fromAlong));
    // A fix far from its shape (detour, bad GPS) is used as-is rather than snapped.
    o.along = p.offset < 150 ? p.along : NaN;
    return o.along;
  }

  private interpolate(id: string, o0: Obs, o1: Obs, t: number): VehicleState {
    const f = (t - o0.v.ts) / (o1.v.ts - o0.v.ts);
    const sameTrip = o0.v.tripId !== undefined && o0.v.tripId === o1.v.tripId;
    const s = sameTrip ? this.shape(o0.v.tripId) : null;
    if (s) {
      const d0 = this.alongOf(o0);
      const d1 = Number.isNaN(d0) ? NaN : this.alongOf(o1, d0 - 50);
      if (!Number.isNaN(d0) && !Number.isNaN(d1) && d1 >= d0) {
        const p = pointAlong(s.coords, s.cum, d0 + (d1 - d0) * f);
        return this.state(id, o0.v, p.lon, p.lat, p.bearing, (d1 - d0) / ((o1.v.ts - o0.v.ts) / 1000), 'interpolated', t, o0);
      }
    }
    const lon = o0.v.lon + (o1.v.lon - o0.v.lon) * f;
    const lat = o0.v.lat + (o1.v.lat - o0.v.lat) * f;
    const bearing = o0.v.bearing ?? headingOf(o0.v, o1.v);
    return this.state(id, o0.v, lon, lat, bearing, undefined, 'interpolated', t, o0);
  }

  private extrapolate(id: string, prev: Obs | undefined, o0: Obs, t: number): VehicleState {
    const s = this.shape(o0.v.tripId);
    const dt = (t - o0.v.ts) / 1000;
    if (s) {
      const d0 = this.alongOf(o0);
      if (!Number.isNaN(d0)) {
        let speed = 0;
        if (prev && prev.v.tripId === o0.v.tripId && (o0.v.ts - prev.v.ts) / 1000 <= this.opts.maxInterpolateS) {
          const dp = this.alongOf(prev);
          if (!Number.isNaN(dp) && d0 >= dp) speed = Math.min(MAX_SPEED, (d0 - dp) / ((o0.v.ts - prev.v.ts) / 1000));
        }
        // Stopped at a stop: don't creep forward.
        if (o0.v.status === 1) speed = 0;
        const d = Math.min(s.cum[s.cum.length - 1]!, d0 + speed * Math.max(0, dt));
        const p = pointAlong(s.coords, s.cum, d);
        return this.state(id, o0.v, p.lon, p.lat, p.bearing, speed, 'observed', t, o0);
      }
    }
    const bearing = o0.v.bearing ?? (prev ? headingOf(prev.v, o0.v) : 0);
    return this.state(id, o0.v, o0.v.lon, o0.v.lat, bearing, undefined, 'observed', t, o0);
  }

  private state(
    id: string,
    v: RtVehicle,
    lon: number,
    lat: number,
    bearing: number,
    speed: number | undefined,
    provenance: VehicleState['provenance'],
    t: number,
    basis: Obs,
  ): VehicleState {
    const trip = v.tripId ? this.pp?.tripIndex.get(v.tripId) : undefined;
    const route = this.pp?.routes.get(v.routeKey);
    const kin = trip?.kin ?? kinematicsFor(this.kin, route?.mode ?? 'bus', v.routeKey);
    const stop = v.stopId ? this.pp?.stopById.get(v.stopId) : undefined;
    const s: VehicleState = {
      id: `rt:${id}`,
      routeKey: v.routeKey,
      mode: route?.mode ?? 'bus',
      tripId: v.tripId ?? '',
      headsign: trip?.trip.headsign ?? '',
      lon,
      lat,
      bearing,
      status: v.status === 1 ? 'dwell' : 'moving',
      provenance,
      source: this.opts.source,
      serviceDate: localDate(t),
      length: kin.length,
      width: kin.width,
      observedAt: basis.v.ts,
    };
    if (speed !== undefined) s.speed = speed;
    if (stop) s.stopName = stop.name;
    if (v.label) s.label = v.label;
    if (v.delay !== undefined) s.delay = v.delay;
    return s;
  }
}

function headingOf(a: RtVehicle, b: RtVehicle): number {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) return a.bearing ?? 0;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Index of the last observation with ts ≤ t, or -1. */
function floorIndex(obs: Obs[], t: number): number {
  let lo = 0;
  let hi = obs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid]!.v.ts <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function floorValue(sorted: number[], t: number): number | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) {
      ans = sorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
