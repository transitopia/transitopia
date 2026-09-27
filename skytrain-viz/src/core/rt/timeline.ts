// Turns a series of RT snapshots into bus positions at any instant, with provenance (PLAN.md §4.5):
//  - between two fixes of the same vehicle ≤ maxInterpolateS apart: moved along the trip's shape,
//    paced by the travel-time profile (stops and slow sections) and fitted to both fixes;
//  - after the latest fix: predicted along the shape with the profile for ≤ maxExtrapolateS. Each new
//    fix corrects the prediction: a bus found to be further ahead glides forward to it; one found to
//    be behind holds still until the prediction catches up (never drives backwards). Big corrections
//    snap;
//  - fixes 150 m–1 km off the trip's shape that still progress plausibly along it are treated as
//    shifted GPS (seen: in-service buses reported ~350–620 m north of their route for 30+ min, on
//    time, while TransLink's stop matching stalled) and placed on the route at their along-route
//    position, as interpolated, with a note; when TransLink's next stop is left behind like that, the
//    next stop and delay are worked out from the position instead;
//  - between trips (a fix before its trip's scheduled departure, or a late start still short of
//    its second stop): at its next trip's first stop (on the route, within BETWEEN_NEAR_START_M)
//    it's drawn there, as a layover; elsewhere it isn't drawn until it starts the trip. Buses lay over and reposition off their route, or their GPS says so (seen: a 99 whose
//    next trip was westbound reported driving east along Broadway, sitting 15 min, looping via
//    Victoria and starting at Commercial–Broadway Bay 5);
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
import { addDays, localDate, serviceDayStart } from '../time.ts';
import type { TripDelay } from './carry.ts';

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
  /** Per obs: how far (m, north/east) the fix is from its along-route position, when it's shifted GPS. */
  shift: ({ n: number; e: number } | undefined)[];
  /** Per obs: the furthest along its trip reached so far (buses don't reverse), filled lazily. */
  held: number[];
  /** Per obs: whether its bus is between trips (not yet running the trip), filled lazily. */
  between: boolean[];
  /** Fetch times of snapshots that included this vehicle, sorted. */
  seenAt: number[];
}

/** Upper bound for plausible bus speed when dead-reckoning (m/s). */
const MAX_SPEED = 25;
/** A fix implying a faster straight-line move than this since the last one is discarded (m/s). */
const IMPLAUSIBLE_SPEED = 45;
/** Fixes within this of their trip shape are on it (m). */
const MAX_SNAP_OFFSET = 150;
/**
 * Fixes up to this far off their shape, progressing plausibly along it from the previous fix, are
 * shifted GPS and placed on the route (m). Recorded data (2026-09-25/26): 98.4 % of fixes are within
 * 50 m, 0.2 % 300–1000 m, mostly two buses shifted ~350–620 m north for 30+ min while on time.
 */
const MAX_SHIFTED_GPS = 1000;
/**
 * Shifted fixes must progress along the route no faster than this (m/s), and in a run of them the
 * offset must stay within SHIFT_DRIFT_M of the previous one: a far-off fix can otherwise match a
 * distant part of the route.
 */
const SHIFTED_MAX_SPEED = 15;
const SHIFT_DRIFT_M = 300;
/** Checked against the last fix placed on the route within this long (s), so one odd fix doesn't end a run. */
const SHIFT_CHAIN_S = 300;
/** The offset-drift check applies between shifted fixes at most this far apart (s). */
const SHIFT_DRIFT_WITHIN_S = 60;
/** With no recent fix on the route, a shifted fix can start a run if it's this close to its timetable (s). */
const SHIFT_SCHEDULE_S = 1200;
/**
 * A standing bus's GPS jitters, including backwards along its route (seen at the 99's layover on
 * N Grandview Hwy: 478 of 2806 fix pairs): moving back less than this is standing still (m).
 */
const JITTER_M = 25;
/**
 * A fix up to this far behind the furthest point its bus has reached on the trip holds the bus there
 * (standing) rather than moving it back: e.g. a 99 at Commercial–Broadway jumped 29–50 m back along
 * its route beside the SkyTrain guideway. Further back is a real correction and resets it (m).
 */
const BACKTRACK_MAX_M = 150;
/** A bus still heading for its first stop this long after its departure time is running the trip (s). */
const LATE_START_S = 900;
/**
 * Between trips, a bus is drawn only on its next trip's route (within BETWEEN_ON_ROUTE_M) and within
 * BETWEEN_NEAR_START_M along it of the trip's first stop (e.g. 99s parked on N Grandview Hwy up to
 * ~70 m past the layover stop) (m).
 */
const BETWEEN_ON_ROUTE_M = 30;
const BETWEEN_NEAR_START_M = 100;
/** Before its second stop, a bus this far off its route, or advancing less than ADVANCING_M, isn't running its trip yet (m). */
const OFF_ROUTE_M = 30;
const ADVANCING_M = 10;
/** ... and within this of its first stop (a bus stopped at a light 1 km along isn't repositioning) (m). */
const NEAR_START_M = 500;
/** A late bus within this of its previous between-trips fix hasn't left its layover spot (m). */
const STILL_M = 30;
/** Between trips, a bus moving at least this far faces the way it moves (less: GPS jitter at a layover) (m). */
const TRIP_CHANGE_MOVE_M = 15;
/** Fixes closer than this give no usable heading; the bus faces along its route instead (m). */
const HEADING_MIN_M = 30;
/** TransLink's next stop is stuck when the bus is this far past it along the route (m). */
const STUCK_NEXT_STOP_M = 200;
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
  /** Every fix time, sorted (for caching per-instant results). */
  private fixTimes: number[] = [];
  private delaysMemo: { upTo: number; delays: TripDelay[] } | undefined;

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
        if (!tr) this.tracks.set(v.id, (tr = { obs: [], along: [], shift: [], held: [], between: [], seenAt: [] }));
        tr.seenAt.push(s.fetchedAt);
        const last = tr.obs[tr.obs.length - 1];
        if (last && last.v.ts === v.ts) continue; // unchanged fix repeated across polls
        if (last && v.ts < last.v.ts) continue; // out-of-order fix
        if (!plausible(v, last?.v)) continue;
        tr.obs.push({ v, knownAt: s.receivedAt ?? s.fetchedAt });
        this.fixTimes.push(v.ts);
      }
    }
    this.fixTimes.sort((a, b) => a - b);
    for (const tr of this.tracks.values()) this.dropSpikes(tr);
  }

  /**
   * Drops lone fixes that jump ahead along the route and are contradicted by the next one (it's
   * back behind by more than GPS jitter, in line with the fix before). Seen: a 99 short-turning at
   * Broadway & Commercial reported once from 60 m up Commercial Dr, then from the corner again, and
   * was drawn driving backwards. Needs the following fix, so live it's the glide/hold that copes.
   */
  private dropSpikes(tr: Track): void {
    const n = tr.obs.length;
    if (n < 3) return;
    this.alongOf(tr, n - 1);
    const spike = (k: number) => {
      const [a, b, c] = [tr.obs[k - 1]!, tr.obs[k]!, tr.obs[k + 1]!];
      if (a.v.tripId !== b.v.tripId || b.v.tripId !== c.v.tripId) return false;
      const [da, db, dc] = [tr.along[k - 1]!, tr.along[k]!, tr.along[k + 1]!];
      return db - dc > JITTER_M && dc >= da - JITTER_M;
    };
    const keep = tr.obs.filter((_, k) => k === 0 || k === n - 1 || !spike(k));
    if (keep.length === n) return;
    tr.obs = keep;
    tr.along = [];
    tr.shift = [];
    tr.held = [];
    tr.between = [];
  }

  /**
   * Each bus's delay, from its latest fix at or before t, against its paced schedule (needs the
   * predictor). Measured where this timeline shows the bus when its prediction runs out (the fix +
   * maxExtrapolateS), so a schedule estimate carrying the delay takes over from exactly there. A bus
   * already at its trip's end by then uses the delay at the fix instead (waiting at the terminus
   * isn't lateness). The same result object is returned until t passes another fix.
   */
  tripDelays(t: number): TripDelay[] {
    const upTo = floorCount(this.fixTimes, t);
    if (this.delaysMemo?.upTo === upTo) return this.delaysMemo.delays;
    const delays: TripDelay[] = [];
    const pr = this.opts.prediction;
    if (pr && this.pp) {
      for (const tr of this.tracks.values()) {
        const i = floorIndex(tr.obs, t);
        if (i < 0) continue;
        const o = tr.obs[i]!;
        const trip = this.trip(o.v.tripId);
        const along = this.alongOf(tr, i);
        if (!trip || trip.route.kind !== 'bus' || Number.isNaN(along)) continue;
        const { date } = this.serviceTime(trip, o.v.ts);
        const secOf = (ms: number) => (ms - serviceDayStart(date)) / 1000;
        const handover = o.v.ts + this.opts.maxExtrapolateS * 1000;
        const shown = this.shownAlong(tr, i, handover)?.along;
        const end = trip.pattern.dist[trip.pattern.dist.length - 1]!;
        const [ms, a] = shown !== undefined && shown < end - 1 ? [handover, shown] : [o.v.ts, along];
        const delay = pr.predictor.delayAt(trip, a, secOf(ms), date);
        delays.push({ tripId: trip.trip.id, serviceDate: date, delay, schedSec: secOf(ms) - delay, fixTs: o.v.ts });
      }
    }
    this.delaysMemo = { upTo, delays };
    return delays;
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
      if (!o0 || this.hidden(tr, i)) continue;
      if (routes && !routes.has(o0.v.routeKey)) continue;
      const next = tr.obs[i + 1];
      if (next && this.hidden(tr, i + 1)) {
        // Known to be off its route next (between trips): stand where it was, rather than head there
        // or predict on past it.
        if ((next.v.ts - o0.v.ts) / 1000 <= this.opts.maxInterpolateS) {
          const st = this.standing(id, tr, i, t);
          if (st) out.push(st);
        }
        continue;
      }
      const o1 = next;
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

  /**
   * Along-shape distance of obs i (NaN when it can't be placed on its route), projecting in order so
   * loops don't snap to a later pass. Marks shifted-GPS fixes in tr.shift.
   */
  private alongOf(tr: Track, i: number): number {
    for (let k = tr.along.length; k <= i; k++) {
      const o = tr.obs[k]!;
      const s = this.shape(o.v.tripId);
      // Last fix on the same trip that was placed on the route, recently.
      let j = k - 1;
      while (j >= 0 && tr.obs[j]!.v.tripId === o.v.tripId && Number.isNaN(tr.along[j]!) && (o.v.ts - tr.obs[j]!.v.ts) / 1000 <= SHIFT_CHAIN_S) j--;
      const prevOk = j >= 0 && tr.obs[j]!.v.tripId === o.v.tripId && !Number.isNaN(tr.along[j]!) && (o.v.ts - tr.obs[j]!.v.ts) / 1000 <= SHIFT_CHAIN_S;
      const prev = prevOk ? tr.along[j]! : NaN;
      let along = NaN;
      let shift: { n: number; e: number } | undefined;
      const trip = this.trip(o.v.tripId);
      if (s && trip && this.isBetween(tr, k)) {
        // Between trips: placed on the route only at its official first stop (else not drawn, see
        // hidden()); GPS elsewhere between trips is as likely to be wrong as the bus is to be there.
        const p = projectOnto(s.coords, s.cum, [o.v.lon, o.v.lat]);
        if (p.offset <= BETWEEN_ON_ROUTE_M && Math.abs(p.along - trip.pattern.dist[0]!) <= BETWEEN_NEAR_START_M) along = Math.max(trip.pattern.dist[0]!, p.along);
      } else if (s) {
        const p = projectOnto(s.coords, s.cum, [o.v.lon, o.v.lat], prevOk ? Math.max(0, prev - 50) : 0);
        if (p.offset < MAX_SNAP_OFFSET) along = p.along;
        else if (p.offset <= MAX_SHIFTED_GPS) {
          // Shifted GPS if it keeps moving along the route at a plausible pace with a steady offset,
          // or (e.g. starting a run, or after a GPS jump) where it is along the route fits the timetable.
          const q = pointAlong(s.coords, s.cum, p.along);
          const v = { n: (o.v.lat - q.lat) * 111_320, e: (o.v.lon - q.lon) * 111_320 * Math.cos((q.lat * Math.PI) / 180) };
          let fits = false;
          if (prevOk) {
            const dt = (o.v.ts - tr.obs[j]!.v.ts) / 1000;
            const moved = p.along - prev;
            const last = dt <= SHIFT_DRIFT_WITHIN_S ? tr.shift[j] : undefined;
            const steady = !last || Math.hypot(v.n - last.n, v.e - last.e) <= SHIFT_DRIFT_M;
            fits = moved >= -30 && moved <= SHIFTED_MAX_SPEED * dt + 50 && steady;
            if (!fits && moved >= -30) fits = this.nearSchedule(o.v, p.along);
          } else fits = this.nearSchedule(o.v, p.along);
          if (fits) {
            along = p.along;
            shift = v;
          }
        }
      }
      tr.along.push(along);
      tr.shift.push(shift);
    }
    return tr.along[i]!;
  }

  /**
   * Whether obs k's bus is between trips: before its trip's scheduled departure, or TransLink's
   * next stop is still the trip's first stop and it hasn't reached the second stop, or it hasn't
   * moved from where it was between trips, at most LATE_START_S past departure (e.g. a late bus
   * leaving its layover spot and repositioning to the start). The limits keep out buses whose stop
   * matching stalled at stop 1 while running the trip (shifted GPS).
   */
  private isBetween(tr: Track, k: number): boolean {
    const cached = tr.between[k];
    if (cached !== undefined) return cached;
    const o = tr.obs[k]!;
    const trip = this.trip(o.v.tripId);
    const s = this.shape(o.v.tripId);
    let between = false;
    if (trip && s) {
      const { sec } = this.serviceTime(trip, o.v.ts);
      if (sec < trip.dep[0]!) between = true;
      else if (sec - trip.dep[0]! <= LATE_START_S) {
        const prev = k > 0 ? tr.obs[k - 1]! : undefined;
        if (o.v.stopId === this.pp!.plan.stops[trip.pattern.stops[0]!]!.id && trip.pattern.dist.length > 1) {
          // TransLink's next stop lags on a long first stretch (e.g. the R2 leaving Park Royal, 1.3 km
          // to its second stop), so also require it not to be making progress along its route: off
          // it, or not advancing since the last fix.
          const p = projectOnto(s.coords, s.cum, [o.v.lon, o.v.lat]);
          let progressing = false;
          if (prev && prev.v.tripId === o.v.tripId) {
            const q = projectOnto(s.coords, s.cum, [prev.v.lon, prev.v.lat]);
            progressing = p.along - q.along >= ADVANCING_M;
          } else progressing = true;
          const first = this.pp!.plan.stops[trip.pattern.stops[0]!]!;
          const nearStart = distM([first.lon, first.lat], [o.v.lon, o.v.lat]) <= NEAR_START_M;
          between = nearStart && p.along < trip.pattern.dist[1]! && (p.offset > OFF_ROUTE_M || !progressing);
        } else if (prev && prev.v.tripId === o.v.tripId && this.isBetween(tr, k - 1)) {
          // Hasn't left its layover spot yet (past its departure time, running late).
          between = distM([prev.v.lon, prev.v.lat], [o.v.lon, o.v.lat]) < STILL_M;
        }
      }
    }
    tr.between[k] = between;
    return between;
  }

  /** Obs i's bus standing where it's drawn for that fix (on its route), or undefined if it can't be placed. */
  private standing(id: string, tr: Track, i: number, t: number): VehicleState | undefined {
    const o = tr.obs[i]!;
    const s = this.shape(o.v.tripId);
    const along = this.heldAlong(tr, i);
    if (!s || Number.isNaN(along)) return undefined;
    const p = pointAlong(s.coords, s.cum, along);
    const between = this.isBetween(tr, i) ? o.v : undefined;
    return this.state(id, o.v, p.lon, p.lat, this.routeBearing(tr, i) ?? p.bearing, 0, 'interpolated', t, o, between ? undefined : { tr, i, along, shifted: tr.shift[i] }, undefined, between);
  }

  /** Between trips and not at its next trip's first stop: not drawn. */
  private hidden(tr: Track, k: number): boolean {
    return this.isBetween(tr, k) && Number.isNaN(this.alongOf(tr, k));
  }

  /** Where obs k is drawn on its route (at its held along), if it can be placed there. */
  private shownPoint(tr: Track, k: number): [number, number] | undefined {
    const s = this.shape(tr.obs[k]!.v.tripId);
    const along = this.heldAlong(tr, k);
    if (!s || Number.isNaN(along)) return undefined;
    const p = pointAlong(s.coords, s.cum, along);
    return [p.lon, p.lat];
  }

  /** Heading of obs k's trip route where the fix sits on it, if it does. */
  private routeBearing(tr: Track, k: number): number | undefined {
    if (k < 0 || k >= tr.obs.length) return undefined;
    const s = this.shape(tr.obs[k]!.v.tripId);
    const along = this.alongOf(tr, k);
    if (!s || Number.isNaN(along)) return undefined;
    const end = s.cum[s.cum.length - 1]!;
    const a = pointAlong(s.coords, s.cum, Math.max(0, along - 10));
    const b = pointAlong(s.coords, s.cum, Math.min(end, along + 10));
    return headingOf({ lon: a.lon, lat: a.lat } as RtVehicle, { lon: b.lon, lat: b.lat } as RtVehicle);
  }

  /** Distance (m) of a fix from its trip's route, if it has one. */
  private offRoute(v: RtVehicle): number | undefined {
    const s = this.shape(v.tripId);
    return s ? projectOnto(s.coords, s.cum, [v.lon, v.lat]).offset : undefined;
  }

  /** Whether a bus at `along` on its trip at the fix's time is within SHIFT_SCHEDULE_S of its timetable. */
  private nearSchedule(v: RtVehicle, along: number): boolean {
    const trip = this.trip(v.tripId);
    const pr = this.opts.prediction;
    if (!trip || !pr) return false;
    const { date, sec } = this.serviceTime(trip, v.ts);
    return Math.abs(pr.predictor.delayAt(trip, along, sec, date)) <= SHIFT_SCHEDULE_S;
  }

  /**
   * Where obs k puts its bus along the trip for display: never behind the furthest point reached on
   * the same trip (within BACKTRACK_MAX_M), so buses don't drive backwards on GPS jitter. NaN when
   * the fix can't be placed on its route.
   */
  private heldAlong(tr: Track, k: number): number {
    for (let j = tr.held.length; j <= k; j++) {
      const d = this.alongOf(tr, j);
      const prev = j > 0 && tr.obs[j - 1]!.v.tripId === tr.obs[j]!.v.tripId ? tr.held[j - 1]! : NaN;
      tr.held.push(Number.isNaN(d) || Number.isNaN(prev) || prev - d > BACKTRACK_MAX_M ? d : Math.max(prev, d));
    }
    return tr.held[k]!;
  }

  /** Service date and service-day second of a fix on a trip (after-midnight trips: previous day). */
  private serviceTime(trip: PreparedTrip, ts: number): { date: string; sec: number } {
    let date = localDate(ts);
    if ((ts - serviceDayStart(date)) / 1000 < trip.trip.start - 6 * 3600) date = addDays(date, -1);
    return { date, sec: (ts - serviceDayStart(date)) / 1000 };
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
      const d0 = this.heldAlong(tr, i);
      const d1 = this.heldAlong(tr, i + 1);
      if (!Number.isNaN(d0) && !Number.isNaN(d1) && d1 >= d0 - BACKTRACK_MAX_M) {
        const dt = (o1.v.ts - o0.v.ts) / 1000;
        // d1 == d0: standing (including fixes that fell back behind where the bus had got to).
        let along = d0 + (d1 - d0) * f;
        let speed = Math.max(0, d1 - d0) / dt;
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
        const between = this.isBetween(tr, i) ? o0.v : undefined;
        return this.state(id, o0.v, p.lon, p.lat, p.bearing, speed, 'interpolated', t, o0, between ? undefined : { tr, i, along, shifted: tr.shift[i] ?? tr.shift[i + 1] }, undefined, between);
      }
    }
    // Straight line between where each fix is shown (on its route where it can be placed), so e.g.
    // a bus switching trips moves from where it was drawn rather than jumping to the raw fix.
    const [lon0, lat0] = this.shownPoint(tr, i) ?? [o0.v.lon, o0.v.lat];
    const [lon1, lat1] = this.shownPoint(tr, i + 1) ?? [o1.v.lon, o1.v.lat];
    const lon = lon0 + (lon1 - lon0) * f;
    const lat = lat0 + (lat1 - lat0) * f;
    // E.g. a bus switching trips while laying over: fixes metres apart say nothing about heading.
    // Nor does a jump backwards along the same trip: buses don't reverse along their route.
    const close = distM([o0.v.lon, o0.v.lat], [o1.v.lon, o1.v.lat]) < HEADING_MIN_M;
    const backwards = sameTrip && this.alongOf(tr, i + 1) < this.alongOf(tr, i);
    // Switching trips with a real move between them (e.g. round from the end of one route to the
    // start of the next): face the way it's moving; neither route's direction describes it.
    const moved = distM([lon0, lat0], [lon1, lat1]);
    const manoeuvre = !sameTrip && moved >= TRIP_CHANGE_MOVE_M;
    const along = (a: [number, number]) => ({ lon: a[0], lat: a[1] }) as RtVehicle;
    const bearing =
      o0.v.bearing ??
      (manoeuvre ? headingOf(along([lon0, lat0]), along([lon1, lat1])) : undefined) ??
      (close || backwards || !sameTrip ? (this.routeBearing(tr, i) ?? this.routeBearing(tr, i + 1)) : undefined) ??
      headingOf(o0.v, o1.v);
    return this.state(id, o0.v, lon, lat, bearing, undefined, 'interpolated', t, o0, undefined, this.offRoute(o0.v));
  }

  /** Predicted along-shape position at t from obs i alone (no correction), with speed. */
  private predicted(tr: Track, i: number, t: number): { along: number; speed: number } | undefined {
    const o0 = tr.obs[i]!;
    const s = this.shape(o0.v.tripId);
    const d0 = this.heldAlong(tr, i);
    // Laying over: stays put until its next fix (it leaves when a fix shows it has).
    if (this.isBetween(tr, i) && !Number.isNaN(d0)) return { along: d0, speed: 0 };
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
      const shifted = tr.shift[i];
      const between = this.isBetween(tr, i) ? o0.v : undefined;
      return this.state(id, o0.v, p.lon, p.lat, p.bearing, shown.speed, shifted ? 'interpolated' : provenance, t, o0, between ? undefined : { tr, i, along: shown.along, shifted }, undefined, between);
    }
    const prev = i > 0 ? tr.obs[i - 1] : undefined;
    const close = prev && distM([prev.v.lon, prev.v.lat], [o0.v.lon, o0.v.lat]) < HEADING_MIN_M;
    const bearing = o0.v.bearing ?? (close ? this.routeBearing(tr, i - 1) : undefined) ?? (prev ? headingOf(prev.v, o0.v) : 0);
    return this.state(id, o0.v, o0.v.lon, o0.v.lat, bearing, undefined, provenance, t, o0, undefined, this.offRoute(o0.v));
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
    /** Where it's shown along its route (and from which obs), to check TransLink's next stop. */
    onRoute?: { tr: Track; i: number; along: number; shifted: { n: number; e: number } | undefined },
    /** Distance from its trip's route (m) when it couldn't be placed on it. */
    offRouteM?: number,
    /** The fix (with its upcoming trip) when the bus is between trips. */
    betweenTrips?: RtVehicle,
  ): VehicleState {
    const trip = this.trip(v.tripId);
    const route = this.pp?.routes.get(v.routeKey);
    const kin = trip?.kin ?? kinematicsFor(this.kin, route?.mode ?? 'bus', v.routeKey);
    let stop = v.stopId ? this.pp?.stopById.get(v.stopId) : undefined;
    let delay = v.delay;
    const notes: string[] = [];
    const next = betweenTrips && this.trip(betweenTrips.tripId);
    if (next && this.pp) {
      // Delay means little before the trip starts; say when it's due to leave instead.
      const first = this.pp.plan.stops[next.pattern.stops[0]!]!;
      const due = Math.round(next.dep[0]!) % 86400;
      const hhmm = `${Math.floor(due / 3600)}:${String(Math.floor((due % 3600) / 60)).padStart(2, '0')}`;
      notes.push(`Between trips: next trip ${next.trip.headsign.replace(/^.*?\bTo\s+/i, 'to ')} departs ${hhmm} from ${first.name} (position as reported)`);
      delay = undefined;
    }
    if (offRouteM !== undefined && offRouteM >= MAX_SNAP_OFFSET) {
      // Not following its trip (e.g. heading to or from the depot): TransLink's delay means little.
      notes.push(`Not on its route (≈ ${offRouteM >= 1000 ? `${(offRouteM / 1000).toFixed(1)} km` : `${Math.round(offRouteM / 50) * 50} m`} away), possibly not in service`);
      delay = undefined;
    }
    if (onRoute?.shifted) {
      const { n, e } = onRoute.shifted;
      const dist = Math.round(Math.hypot(n, e) / 50) * 50;
      const dir = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(((Math.atan2(e, n) * 180) / Math.PI + 360) / 45) % 8];
      notes.push(`GPS appears offset ≈ ${dist} m ${dir}; shown on its route`);
    }
    if (trip && onRoute && this.pp) {
      // TransLink's next stop left well behind: its stop matching (and so its delay) has stalled.
      const ids = trip.pattern.stops.map((si) => this.pp!.plan.stops[si]!.id);
      const next = v.stopId ? ids.indexOf(v.stopId) : -1;
      const fixAlong = this.alongOf(onRoute.tr, onRoute.i);
      if (next >= 0 && fixAlong > trip.pattern.dist[next]! + STUCK_NEXT_STOP_M) {
        const actual = trip.pattern.dist.findIndex((d) => d > onRoute.along);
        stop = actual >= 0 ? this.pp.plan.stops[trip.pattern.stops[actual]!] : undefined;
        const pr = this.opts.prediction;
        if (pr) {
          const { date, sec } = this.serviceTime(trip, basis.v.ts);
          delay = Math.round(pr.predictor.delayAt(trip, fixAlong, sec, date));
        } else delay = undefined;
        notes.push(`TransLink's next stop is stuck at ${this.pp.stopById.get(v.stopId!)?.name ?? v.stopId}; next stop and delay worked out from the position`);
      }
    }
    const s: VehicleState = {
      id: `rt:${id}`,
      routeKey: v.routeKey,
      mode: route?.mode ?? 'bus',
      tripId: v.tripId ?? '',
      headsign: trip?.trip.headsign ?? '',
      lon,
      lat,
      bearing,
      status: speed !== undefined && speed > 0 ? 'moving' : next ? 'layover' : speed === 0 ? 'dwell' : 'moving',
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
    if (delay !== undefined) s.delay = delay;
    if (notes.length) s.note = notes.join('. ');
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

/** How many values are ≤ t. */
function floorCount(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
