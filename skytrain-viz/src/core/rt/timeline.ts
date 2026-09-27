// Turns a series of RT snapshots into bus positions at any instant, with provenance (PLAN.md §4.5):
//  - between two fixes of the same vehicle ≤ maxInterpolateS apart: moved along the trip's shape,
//    paced by the travel-time profile (stops and slow sections) and fitted to both fixes;
//  - after the latest fix: predicted along the shape with the profile for ≤ maxExtrapolateS. Each new
//    fix corrects the prediction: a bus found to be further ahead glides forward to it; one found to
//    be behind holds still until the prediction catches up (never drives backwards). Big corrections
//    snap;
//  - otherwise the vehicle is not shown (the caller falls back to schedule estimates when the
//    instant isn't covered by RT data at all).
// Pure given its inputs: the same snapshots and t always give the same answer. A fix counts as
// known from the first snapshot that contained it: when this client received it (live), or when the
// service fetched it (recorded, so corrections and their glides replay the same way every time).

import { cumulativeLengths, distM, pointAlong, projectOnto, type LonLat } from '../geo.ts';
import type { PreparedPlan, PreparedTrip, VehicleState } from '../schedule/engine.ts';
import { kinematicsFor, type KinematicsConfig } from '../movement/kinematics.ts';
import { Predictor, type PredictionConfig } from './profile.ts';
import type { RtSnapshot, RtVehicle } from './types.ts';
import { localDate } from '../time.ts';

export interface TimelineOptions {
  maxInterpolateS: number;
  maxExtrapolateS: number;
  /** Label for VehicleState.source, e.g. "GTFS-RT live". */
  source: string;
  /** Profile-based prediction and correction settings; without it, fixed-speed dead reckoning. */
  prediction?: { cfg: PredictionConfig; predictor: Predictor };
}

interface Obs {
  v: RtVehicle;
  /** When the fix became known: receipt (live) or fetch (recorded) of the first snapshot with it. */
  knownAt: number;
}

interface Track {
  obs: Obs[]; // sorted by v.ts, unique ts
  /** Distance along the trip shape per obs (m), filled lazily in order; NaN when unknown. */
  along: number[];
  /** Fetch times of snapshots that included this vehicle, sorted. */
  seenAt: number[];
}

/** Upper bound for plausible bus speed when dead-reckoning (m/s). */
const MAX_SPEED = 25;
/** A fix implying a faster straight-line move than this since the last one is discarded (m/s). */
const IMPLAUSIBLE_SPEED = 45;
/** Fixes further than this from their trip shape are used as-is rather than snapped (m). */
const MAX_SNAP_OFFSET = 150;
/** A prediction this close to its fix still counts as observed (s). */
const OBSERVED_S = 10;
/** Nested corrections considered when working out what was shown before a fix arrived. */
const MAX_CORRECTION_DEPTH = 3;

export class RtTimeline {
  private tracks = new Map<string, Track>();
  private fetchTimes: number[] = [];
  private shapeCache = new Map<string, { coords: LonLat[]; cum: Float64Array } | null>();
  /** `${id}#${i}` → along shown when obs i became known, using fixes before it. */
  private shownAtFetch = new Map<string, number>();

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
        if (!tr) this.tracks.set(v.id, (tr = { obs: [], along: [], seenAt: [] }));
        tr.seenAt.push(s.fetchedAt);
        const last = tr.obs[tr.obs.length - 1];
        if (last && last.v.ts === v.ts) continue; // unchanged fix repeated across polls
        if (last && v.ts < last.v.ts) continue; // out-of-order fix
        if (!plausible(v, last?.v)) continue;
        tr.obs.push({ v, knownAt: s.receivedAt ?? s.fetchedAt });
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
        out.push(this.interpolate(id, tr, i, t));
        continue;
      }
      // No usable later fix: predict, but only while the vehicle is still being reported.
      if ((t - o0.v.ts) / 1000 > this.opts.maxExtrapolateS) continue;
      const lastSeen = floorValue(tr.seenAt, t);
      if (latestFetch !== undefined && lastSeen !== undefined && latestFetch > lastSeen) continue;
      out.push(this.extrapolate(id, tr, i, t));
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

  /** Along-shape distance of obs i, projecting in order so loops don't snap to a later pass. */
  private alongOf(tr: Track, i: number): number {
    for (let k = tr.along.length; k <= i; k++) {
      const o = tr.obs[k]!;
      const s = this.shape(o.v.tripId);
      if (!s) {
        tr.along.push(NaN);
        continue;
      }
      const prev = k > 0 && tr.obs[k - 1]!.v.tripId === o.v.tripId ? tr.along[k - 1]! : NaN;
      const p = projectOnto(s.coords, s.cum, [o.v.lon, o.v.lat], Number.isNaN(prev) ? 0 : Math.max(0, prev - 50));
      tr.along.push(p.offset < MAX_SNAP_OFFSET ? p.along : NaN);
    }
    return tr.along[i]!;
  }

  private trip(tripId: string | undefined): PreparedTrip | undefined {
    return tripId ? this.pp?.tripIndex.get(tripId) : undefined;
  }

  private interpolate(id: string, tr: Track, i: number, t: number): VehicleState {
    const o0 = tr.obs[i]!;
    const o1 = tr.obs[i + 1]!;
    const f = (t - o0.v.ts) / (o1.v.ts - o0.v.ts);
    const sameTrip = o0.v.tripId !== undefined && o0.v.tripId === o1.v.tripId;
    const s = sameTrip ? this.shape(o0.v.tripId) : null;
    if (s) {
      const d0 = this.alongOf(tr, i);
      const d1 = this.alongOf(tr, i + 1);
      if (!Number.isNaN(d0) && !Number.isNaN(d1) && d1 >= d0) {
        const dt = (o1.v.ts - o0.v.ts) / 1000;
        let along = d0 + (d1 - d0) * f;
        let speed = (d1 - d0) / dt;
        // Paced by the profile, scaled to take exactly as long as the bus did.
        const trip = this.trip(o0.v.tripId);
        const pr = this.opts.prediction;
        if (pr && trip && d1 > d0) {
          const c = pr.predictor.course(trip, o0.v.ts);
          const expected = pr.predictor.timeBetween(c, d0, d1);
          if (expected > 0) {
            const w = pr.predictor.walk(c, d0, (t - o0.v.ts) / 1000, dt / expected);
            along = Math.min(d1, w.along);
            speed = w.speed;
          }
        }
        const p = pointAlong(s.coords, s.cum, along);
        return this.state(id, o0.v, p.lon, p.lat, p.bearing, speed, 'interpolated', t, o0);
      }
    }
    const lon = o0.v.lon + (o1.v.lon - o0.v.lon) * f;
    const lat = o0.v.lat + (o1.v.lat - o0.v.lat) * f;
    const bearing = o0.v.bearing ?? headingOf(o0.v, o1.v);
    return this.state(id, o0.v, lon, lat, bearing, undefined, 'interpolated', t, o0);
  }

  /** Predicted along-shape position at t from obs i alone (no correction), with speed. */
  private predicted(tr: Track, i: number, t: number): { along: number; speed: number } | undefined {
    const o0 = tr.obs[i]!;
    const s = this.shape(o0.v.tripId);
    const d0 = this.alongOf(tr, i);
    if (!s || Number.isNaN(d0)) return undefined;
    const dt = Math.max(0, (t - o0.v.ts) / 1000);
    const length = s.cum[s.cum.length - 1]!;
    const trip = this.trip(o0.v.tripId);
    const pr = this.opts.prediction;
    if (pr && trip) {
      const c = pr.predictor.course(trip, o0.v.ts);
      const recent: { along: number; ts: number }[] = [];
      for (let k = i; k >= 0 && tr.obs[k]!.v.tripId === o0.v.tripId && (o0.v.ts - tr.obs[k]!.v.ts) / 1000 <= pr.cfg.paceWindowS; k--) {
        const a = this.alongOf(tr, k);
        if (!Number.isNaN(a)) recent.unshift({ along: a, ts: tr.obs[k]!.v.ts });
      }
      const w = pr.predictor.walk(c, d0, dt, pr.predictor.paceFactor(c, recent));
      return { along: Math.min(length, w.along), speed: w.speed };
    }
    // Fixed speed from the previous fix.
    let speed = 0;
    const prev = i > 0 ? tr.obs[i - 1] : undefined;
    if (prev && prev.v.tripId === o0.v.tripId && (o0.v.ts - prev.v.ts) / 1000 <= this.opts.maxInterpolateS) {
      const dp = this.alongOf(tr, i - 1);
      if (!Number.isNaN(dp) && d0 >= dp) speed = Math.min(MAX_SPEED, (d0 - dp) / ((o0.v.ts - prev.v.ts) / 1000));
    }
    return { along: Math.min(length, d0 + speed * dt), speed };
  }

  /**
   * Along-shape position shown at t when obs i is the latest fix known: the prediction from obs i,
   * corrected smoothly from what was shown when it became known.
   */
  private shownAlong(tr: Track, i: number, t: number, depth = 0): { along: number; speed: number } | undefined {
    const raw = this.predicted(tr, i, t);
    const pr = this.opts.prediction;
    if (!raw || !pr || i === 0 || depth >= MAX_CORRECTION_DEPTH) return raw;
    const o = tr.obs[i]!;
    const p = tr.obs[i - 1]!;
    const F = o.knownAt;
    if (t < F || p.v.tripId !== o.v.tripId || p.knownAt >= F) return raw;
    // Was the vehicle shown at F (from fix i-1, not too old)?
    if ((F - p.v.ts) / 1000 > this.opts.maxExtrapolateS) return raw;
    const key = `${o.v.id}#${i}`;
    let before = this.shownAtFetch.get(key);
    if (before === undefined) {
      before = this.shownAlong(tr, i - 1, F, depth + 1)?.along ?? NaN;
      this.shownAtFetch.set(key, before);
    }
    if (Number.isNaN(before)) return raw;
    const rawAtF = this.predicted(tr, i, F)!.along;
    const err = before - rawAtF;
    if (Math.abs(err) > pr.cfg.snapM) return raw;
    if (err > 0) {
      // Shown ahead of where the bus turned out to be: hold until the prediction catches up.
      return raw.along >= before ? raw : { along: before, speed: 0 };
    }
    // Shown behind: glide forward to the prediction.
    const glide = Math.min(pr.cfg.maxGlideS, Math.max(pr.cfg.minGlideS, -err / pr.cfg.catchUpMps));
    const x = (t - F) / 1000 / glide;
    if (x >= 1) return raw;
    const w = 1 - x * x * (3 - 2 * x); // smoothstep, 1 → 0
    const dw = (6 * x * (1 - x)) / glide; // −dw/dt
    return { along: raw.along + err * w, speed: raw.speed - err * dw };
  }

  private extrapolate(id: string, tr: Track, i: number, t: number): VehicleState {
    const o0 = tr.obs[i]!;
    const s = this.shape(o0.v.tripId);
    const shown = s ? this.shownAlong(tr, i, t) : undefined;
    const provenance = (t - o0.v.ts) / 1000 <= OBSERVED_S ? 'observed' : 'interpolated';
    if (s && shown) {
      const p = pointAlong(s.coords, s.cum, shown.along);
      return this.state(id, o0.v, p.lon, p.lat, p.bearing, shown.speed, provenance, t, o0);
    }
    const prev = i > 0 ? tr.obs[i - 1] : undefined;
    const bearing = o0.v.bearing ?? (prev ? headingOf(prev.v, o0.v) : 0);
    return this.state(id, o0.v, o0.v.lon, o0.v.lat, bearing, undefined, provenance, t, o0);
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
    const trip = this.trip(v.tripId);
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
      status: speed === 0 ? 'dwell' : 'moving',
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

/** Rejects fixes outside the world's plausible range, or implying an impossible jump from the last. */
function plausible(v: RtVehicle, last: RtVehicle | undefined): boolean {
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || Math.abs(v.lat) < 1 || Math.abs(v.lon) < 1) return false;
  if (!last) return true;
  const dt = (v.ts - last.ts) / 1000;
  return dt <= 0 || distM([last.lon, last.lat], [v.lon, v.lat]) / dt <= IMPLAUSIBLE_SPEED;
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
