// Bus travel-time profiles learned from recorded GTFS-RT positions, and a predictor that walks a bus
// forward along its trip with them (packages/transit-core/DESIGN.md#buses).
//
// Profile, per trip shape and time-of-day band:
//  - pace (s/m) per bin along the shape, from consecutive fixes of the same trip. Time between two
//    fixes is spread over the bins between them in proportion to distance; a bus that didn't move
//    (< stationaryM) near a stop is dwelling there, elsewhere it is held in traffic or at a signal
//    and that time stays in the bin's pace.
//  - expected dwell (s) per stop: the mean time buses stood at it per visit (ProfileBuilder), plus
//    the extra time spent around the stop compared with the pace nearby. With fixes ~30-60 s apart
//    most dwells aren't seen as standing still: they show up as slow bins around the stop instead,
//    so that excess is moved into the dwell (and those bins get the nearby pace), which is what
//    makes predicted buses visibly stop.
//  - the stops where a route's buses hold to the timetable (timing points, and layovers at a
//    second-to-last stop before the next trip in the block: holdDeparture), from every band.
// Totals are preserved: pace × distance + dwells ≈ observed running time, except around holds.
// Frozen GPS (stale.ts) is left out, as in the timeline.
//
// Published one band per file (profile-bands.ts), with the all-day profile filled in where a band
// has no data.
//
// Prediction: from a fix, walk bin by bin, stopping at each upcoming stop for its expected dwell,
// scaled by how this bus has been running relative to the profile, and holding at stops where buses
// hold until the timetable's time there (a late bus doesn't wait); a bus seen before its trip's start
// waits for it. Gaps (and bands not loaded yet) fall back to the timetable, then to a default speed.
// Stops TransLink reports as skipped by a trip (GTFS-RT, e.g. on a detour) get no dwell or hold.

import { cumulativeLengths, projectOnto, type LonLat } from "../geo.ts";
import type {
  PreparedPlan,
  PreparedTrip,
  TripPacer,
} from "../schedule/engine.ts";
import {
  addDays,
  localDate,
  serviceDayStart,
  toWallTime,
  type ServiceDate,
} from "../time.ts";
import type { RtBandProfile } from "./profile-bands.ts";
import { frozenFixes, type FreezeFix, type FrozenGpsConfig } from "./stale.ts";
import type { RtSnapshot, RtVehicle } from "./types.ts";

export interface PredictionConfig {
  /** Profile bin length along the shape (m). */
  binM: number;
  /** Local hours at which each time-of-day band starts, ascending, first = 0. */
  bandStartHours: number[];
  /** Consecutive fixes further apart than this aren't used for the profile (s). */
  maxPairS: number;
  /** Fixes further than this from the trip shape aren't used (m). */
  maxOffsetM: number;
  /** A bus that moved less than this between fixes was standing still (m). */
  stationaryM: number;
  /** Standing still within this distance of a stop counts as dwelling there (m). */
  stopZoneM: number;
  /** Extra time in bins within this distance of a stop, vs the pace nearby, becomes dwell (m). */
  stopExcessM: number;
  /** "Pace nearby" = median pace of bins away from stops within this distance (m). */
  baselineWindowM: number;
  /** A bin's pace is used once it has this many metres of observed travel (≈ passes × binM). */
  minBinMetres: number;
  /** A stop's dwell is used once this many visits were seen. */
  minStopPasses: number;
  /** A visit arrived early at a stop when first seen there this long before its departure time (s). */
  holdEarlyS: number;
  /** ...and held when it left no earlier than this before it (s). */
  holdTolS: number;
  /** A route's buses hold at a stop when this share of its early visits held... */
  holdShare: number;
  /** ...from at least this many early visits. */
  minHoldVisits: number;
  /** Speed when nothing else is known (m/s). */
  defaultSpeedMps: number;
  /** Dwell per stop when nothing else is known (s). */
  defaultDwellS: number;
  /** Expected dwells shorter than this are driven through (s). */
  minDwellS: number;
  /** Recent fixes (within this many seconds) set the bus's pace relative to the profile. */
  paceWindowS: number;
  /** How far to trust the bus's recent pace over the profile (0 = profile only, 1 = fully). */
  paceWeight: number;
  /** Clamp for the pace factor (× profile time). */
  paceClamp: [number, number];
  /** Corrections catch up at up to this much faster than the bus (m/s). */
  catchUpMps: number;
  /** Glide duration bounds (s). */
  minGlideS: number;
  maxGlideS: number;
  /** Corrections larger than this snap instead of gliding or holding (m). */
  snapM: number;
  /**
   * Schedule estimates follow the profile between timetable times at least this far apart (s),
   * scaled to meet them: per-stop bus times are interpolated by the agency, so the profile decides
   * where time goes in between.
   */
  scheduleAnchorS: number;
}

export interface BandProfile {
  /** s/m per bin; null where too little data. */
  pace: (number | null)[];
  /** stop_id → expected dwell per pass (s). */
  dwell: Record<string, number>;
}

export interface ShapeProfile {
  /** Index = band; null where the band has no data. */
  bands: (BandProfile | null)[];
  all: BandProfile;
  /** Stops where buses hold to the timetable (holdDeparture), from every band. */
  holds?: string[];
}

/** A learned profile, every band; published per band (profile-bands.ts). */
export interface RtProfile {
  feedVersion: string;
  builtAt: string;
  binM: number;
  bandStartHours: number[];
  /** Recorded hours used, e.g. ["2026-09-26T17"]. */
  hours: string[];
  shapes: Record<string, ShapeProfile>;
}

/** Band index for a local hour. */
export function bandOf(bandStartHours: number[], hour: number): number {
  let b = 0;
  for (let i = 0; i < bandStartHours.length; i++)
    if (hour >= bandStartHours[i]!) b = i;
  return b;
}

// toWallTime reuses one formatter per time zone: creating an Intl.DateTimeFormat per fix allocated
// native ICU memory faster than GC freed it (~8 GB for five days of fixes in build:rt-profile).
const localHour = (ms: number, tz: string) => toWallTime(ms, tz).hour;

/** A stop's visits: how many, and their stands' total (s). */
interface Stands {
  n: number;
  total: number;
}

interface Acc {
  time: Float64Array;
  metres: Float64Array;
  /** Stop → its visits' stands. */
  stands: Map<string, Stands>;
  /** Stop → the stands of visits that arrived after its departure time (holdDeparture). */
  late: Map<string, Stands>;
}

/** Evidence, over every band, that a route's buses hold at a stop. */
interface HoldCounts {
  /** Visits that arrived well before the departure time (holdDeparture), after the trip's start... */
  early: number;
  /** ...and of those, the ones that left around or after it. */
  held: number;
}

/** A trip's bus at one of its stops: from its first fix in the stop's zone to leaving it. */
interface StopVisit {
  /** Standing within the zone after the trip's scheduled start (s). */
  standS: number;
  /** First and last fix in the zone (epoch ms). */
  firstMs: number;
  lastMs: number;
}

/** A vehicle on one trip, while its fixes are placed on the trip's shape. */
interface TripRun {
  tripId: string;
  trip: PreparedTrip;
  /** Start of its service day (epoch ms). */
  dayStartMs: number;
  /** Where its first fix on the trip was along the shape. */
  firstAlong: number;
  /** Index of the first stop whose visit isn't closed yet. */
  next: number;
  /** Open visits by stop index. */
  visits: Map<number, StopVisit>;
}

interface VehicleTrack {
  /** The current run of fixes at exactly one position, held until it ends (frozen GPS). */
  pending: RtVehicle[];
  /** Whether a run was released already (the first may have begun before the recordings). */
  released: boolean;
  /** Its last fix used, and where it was along its trip's shape (undefined: off it). */
  last?: { v: RtVehicle; along: number | undefined };
  run?: TripRun | undefined;
}

/**
 * When a trip's bus leaves its i-th stop if the stop is one where buses hold (service-day s): its
 * departure time there; at its second-to-last stop, if it lays over for a next trip at the terminus,
 * no earlier than that trip's start less the timetable's running time to the last stop (buses wait
 * there rather than at the terminus, still reporting this trip: 408 at Horseshoe Way).
 */
export function holdDeparture(trip: PreparedTrip, i: number): number {
  const n = trip.dep.length;
  const dep = trip.dep[i]!;
  return i === n - 2 && trip.next ?
      Math.max(dep, trip.next.dep[0]! - (trip.arr[n - 1]! - dep))
    : dep;
}

/**
 * Accumulates fixes into profiles. Feed it hours of snapshots oldest first, then build(). Fixes are
 * folded into the accumulators as they arrive, keeping only each vehicle's last fix (and its current
 * run of repeated positions): weeks of every bus's fixes don't fit in the heap.
 *
 * Dwells: each trip's visit to a stop counts once, however far apart its fixes are, when its bus was
 * seen arriving and then leaving with fixes at most maxPairS apart (at longer intervals short stands
 * go unseen, so only long ones would count; and a bus first seen at a stop may have been laying over
 * there). Its stand is the time it stood within stopZoneM, between fixes up to maxPairS apart, after
 * its trip's scheduled start: before it, the bus is laying over, and Predictor.walk holds it until
 * the start. A stop's dwell is the mean stand of its visits (more robust statistics, e.g. trimming
 * the longest 5-20 %, predicted worse: packages/transit-core/DESIGN.md#buses), plus the slow time
 * around it. Not at a pattern's first and last stops (prediction never dwells there), nor a stand
 * that lasts until its trip ends.
 *
 * Holds: a route's buses hold at a stop when at least holdShare of its visits that arrived
 * holdEarlyS or more before their departure time there (holdDeparture), after their trip's start,
 * left no earlier than holdTolS before it (or stood there until their trip ended). The stop's dwell
 * then comes from the visits that arrived after the departure time: those don't wait.
 */
export class ProfileBuilder {
  private acc = new Map<string, Acc[]>(); // shape → per band (+1 for all-day)
  private holds = new Map<string, HoldCounts>(); // "<route key>|<stop id>" → counts
  /** Shape → the routes whose trips run on it. */
  private shapeRoutes = new Map<string, Set<string>>();
  private vehicles = new Map<string, VehicleTrack>();
  /** Shape → its stops (id, along), from the trips seen on it. */
  private shapeStops = new Map<string, Map<string, number>>();
  private hours = new Set<string>();

  private pp: PreparedPlan;
  private cfg: PredictionConfig;
  private frozenGps: FrozenGpsConfig | undefined;

  /** @param frozenGps Leaves frozen GPS out (stale.ts), as the timeline does. */
  constructor(
    pp: PreparedPlan,
    cfg: PredictionConfig,
    frozenGps?: FrozenGpsConfig,
  ) {
    this.pp = pp;
    this.cfg = cfg;
    this.frozenGps = frozenGps;
  }

  /** One batch (an hour) of snapshots, after every earlier batch; any order within it. */
  add(snapshots: RtSnapshot[], hourLabel?: string): void {
    if (hourLabel) this.hours.add(hourLabel);
    const byVehicle = new Map<string, RtVehicle[]>();
    for (const s of snapshots)
      for (const v of s.vehicles) {
        if (!v.tripId) continue;
        let list = byVehicle.get(v.id);
        if (!list) byVehicle.set(v.id, (list = []));
        list.push(v);
      }
    for (const [id, list] of byVehicle) {
      list.sort((a, b) => a.ts - b.ts);
      let vt = this.vehicles.get(id);
      if (!vt) this.vehicles.set(id, (vt = { pending: [], released: false }));
      for (const v of list) this.take(vt, v);
    }
  }

  /**
   * Takes a vehicle's next fix: it extends the current run of fixes at one position, or ends it,
   * and the run's fixes that weren't frozen GPS are used.
   */
  private take(vt: VehicleTrack, v: RtVehicle): void {
    const last = vt.pending.at(-1) ?? vt.last?.v;
    // Repeats of a fix in later polls, and fixes older than one already taken.
    if (last && v.ts <= last.ts) return;
    const first = vt.pending[0];
    if (
      !this.frozenGps
      || (first && v.lat === first.lat && v.lon === first.lon)
    )
      vt.pending.push(v);
    else {
      this.release(vt, v);
      vt.pending = [v];
    }
    if (!this.frozenGps) this.release(vt);
  }

  /** Uses a vehicle's held fixes, less frozen ones; `next` is the fix that ended their run. */
  private release(vt: VehicleTrack, next?: RtVehicle): void {
    const run = vt.pending;
    vt.pending = [];
    if (!run.length) return;
    let frozen: Set<number> | undefined;
    if (this.frozenGps && run.length > 1) {
      const fixes: FreezeFix[] = (next ? [...run, next] : run).map((f) => {
        const st = f.stopId ? this.pp.stopById.get(f.stopId) : undefined;
        return {
          lat: f.lat,
          lon: f.lon,
          tripId: f.tripId,
          stop: f.stopId,
          stopAt: st ? [st.lon, st.lat] : undefined,
        };
      });
      frozen = frozenFixes(fixes, this.frozenGps, !vt.released);
    }
    vt.released = true;
    run.forEach((f, k) => {
      if (!frozen?.has(k)) this.addFix(vt, f);
    });
  }

  private addFix(vt: VehicleTrack, v: RtVehicle): void {
    const { cfg, pp } = this;
    const prev = vt.last;
    const trip = pp.tripIndex.get(v.tripId!);
    const coords =
      trip && (pp.plan.shapes[trip.pattern.shape] as LonLat[] | undefined);
    if (!trip || !coords) {
      this.endRun(vt);
      vt.last = { v, along: undefined };
      return;
    }
    const cum =
      pp.shapeCum.get(trip.pattern.shape) ?? cumulativeLengths(coords);
    const sameTrip =
      prev?.along !== undefined && prev.v.tripId === v.tripId ?
        prev
      : undefined;
    const p = projectOnto(
      coords,
      cum,
      [v.lon, v.lat],
      sameTrip ? Math.max(0, sameTrip.along! - 50) : 0,
    );
    if (p.offset > cfg.maxOffsetM) {
      this.endRun(vt);
      vt.last = { v, along: undefined };
      return;
    }
    if (!sameTrip || vt.run?.tripId !== v.tripId)
      this.startRun(vt, v, trip, p.along);
    const run = vt.run!;
    const dt = sameTrip ? (v.ts - sameTrip.v.ts) / 1000 : Infinity;
    if (
      sameTrip
      && dt <= cfg.maxPairS
      && p.along >= sameTrip.along! - cfg.stationaryM
    )
      this.addPair(
        run,
        cum[cum.length - 1]!,
        sameTrip.along!,
        p.along,
        sameTrip.v.ts,
        v.ts,
      );
    this.visit(run, p.along, v.ts, sameTrip?.v.ts);
    vt.last = { v, along: p.along };
  }

  private startRun(
    vt: VehicleTrack,
    v: RtVehicle,
    trip: PreparedTrip,
    along: number,
  ): void {
    this.endRun(vt);
    const { pp, cfg } = this;
    const date = tripServiceDate(trip, v.ts, pp.plan.timezone);
    const dist = trip.pattern.dist;
    let next = 0;
    while (next < dist.length && dist[next]! + cfg.stopZoneM < along) next++;
    vt.run = {
      tripId: v.tripId!,
      trip,
      dayStartMs: serviceDayStart(date, pp.plan.timezone),
      firstAlong: along,
      next,
      visits: new Map(),
    };
    let known = this.shapeStops.get(trip.pattern.shape);
    if (!known) this.shapeStops.set(trip.pattern.shape, (known = new Map()));
    trip.pattern.stops.forEach((si, i) =>
      known.set(pp.plan.stops[si]!.id, dist[i]!),
    );
    let routes = this.shapeRoutes.get(trip.pattern.shape);
    if (!routes) this.shapeRoutes.set(trip.pattern.shape, (routes = new Set()));
    routes.add(trip.route.key);
  }

  /** The vehicle left its trip (or its shape): visits it was standing at end with it. */
  private endRun(vt: VehicleTrack): void {
    const run = vt.run;
    if (!run) return;
    vt.run = undefined;
    for (const [i, visit] of run.visits)
      if (i >= run.next) this.closeVisit(run, i, visit, undefined, true);
  }

  /** A fix at `along`: opens visits of stops it's near, closes those it has left behind. */
  private visit(
    run: TripRun,
    along: number,
    ts: number,
    prevTs: number | undefined,
  ): void {
    const { cfg } = this;
    const dist = run.trip.pattern.dist;
    for (
      let i = run.next;
      i < dist.length && dist[i]! <= along + cfg.stopZoneM;
      i++
    ) {
      if (Math.abs(dist[i]! - along) > cfg.stopZoneM) continue;
      const v = run.visits.get(i);
      if (v) v.lastMs = ts;
      else run.visits.set(i, { standS: 0, firstMs: ts, lastMs: ts });
    }
    while (run.next < dist.length && dist[run.next]! + cfg.stopZoneM < along) {
      const i = run.next++;
      const v = run.visits.get(i);
      run.visits.delete(i);
      if (v) this.closeVisit(run, i, v, ts, false);
      // Passed without a fix near it: its stand is known (none seen) if the fixes either side were
      // close enough in time, and the trip was seen before it.
      else if (
        prevTs !== undefined
        && (ts - prevTs) / 1000 <= cfg.maxPairS
        && run.firstAlong < dist[i]! - cfg.stopZoneM
      ) {
        const at = (prevTs + ts) / 2;
        this.closeVisit(
          run,
          i,
          { standS: 0, firstMs: at, lastMs: at },
          at,
          false,
        );
      }
    }
  }

  /**
   * A visit is over: `leftMs` is the fix that found the bus gone (undefined: it never left), `ended`
   * whether its trip ended there. Only visits seen arriving count (a bus first seen at a stop may
   * have been laying over), and their stand only when seen leaving with fixes at most maxPairS
   * apart: at longer intervals short stands go unseen, and only long ones would count.
   */
  private closeVisit(
    run: TripRun,
    i: number,
    visit: StopVisit,
    leftMs: number | undefined,
    ended: boolean,
  ): void {
    const { cfg, pp } = this;
    const { trip } = run;
    const pattern = trip.pattern;
    if (i === 0 || i === pattern.stops.length - 1) return;
    if (run.firstAlong >= pattern.dist[i]! - cfg.stopZoneM) return;
    const left =
      leftMs !== undefined && (leftMs - visit.lastMs) / 1000 <= cfg.maxPairS ?
        (visit.lastMs + leftMs) / 2
      : undefined;
    const stop = pp.plan.stops[pattern.stops[i]!]!.id;
    const startMs = run.dayStartMs + trip.dep[0]! * 1000;
    const depMs = run.dayStartMs + holdDeparture(trip, i) * 1000;
    const tolMs = cfg.holdTolS * 1000;
    // Arrived well before its departure time: did it wait? A trip that ended while its bus stood
    // there waited, if it was still there near the departure time (else it's unknown).
    const held =
      left !== undefined ? left >= depMs - tolMs
      : ended && visit.lastMs >= depMs - tolMs ? true
      : undefined;
    if (
      held !== undefined
      && visit.firstMs >= startMs
      && visit.firstMs <= depMs - cfg.holdEarlyS * 1000
    ) {
      const key = `${trip.route.key}|${stop}`;
      let c = this.holds.get(key);
      if (!c) this.holds.set(key, (c = { early: 0, held: 0 }));
      c.early++;
      if (held) c.held++;
    }
    if (ended || left === undefined) return;
    const band = bandOf(
      cfg.bandStartHours,
      localHour(visit.firstMs, pp.plan.timezone),
    );
    const accs = this.accFor(pattern.shape, trip);
    for (const a of [accs[band]!, accs[accs.length - 1]!]) {
      addStand(a.stands, stop, visit.standS);
      if (visit.firstMs >= depMs) addStand(a.late, stop, visit.standS);
    }
  }

  private accFor(shape: string, trip: PreparedTrip): Acc[] {
    let a = this.acc.get(shape);
    if (!a) {
      const cum = this.pp.shapeCum.get(shape);
      const length =
        cum ?
          cum[cum.length - 1]!
        : trip.pattern.dist[trip.pattern.dist.length - 1]!;
      const bins = Math.max(1, Math.ceil(length / this.cfg.binM));
      a = Array.from({ length: this.cfg.bandStartHours.length + 1 }, () => ({
        time: new Float64Array(bins),
        metres: new Float64Array(bins),
        stands: new Map(),
        late: new Map(),
      }));
      this.acc.set(shape, a);
    }
    return a;
  }

  build(): RtProfile {
    const { cfg, pp } = this;
    // Fixes still held (a run going on as the recordings end), and visits still open.
    for (const vt of this.vehicles.values()) {
      this.release(vt);
      this.endRun(vt);
    }
    const shapes: Record<string, ShapeProfile> = {};
    for (const [shape, accs] of this.acc) {
      const stops = [...(this.shapeStops.get(shape) ?? [])].map(
        ([id, along]) => ({ id, along }),
      );
      const routes = [...(this.shapeRoutes.get(shape) ?? [])];
      const holds = new Set(
        stops
          .filter(({ id }) =>
            routes.some((r) => {
              const c = this.holds.get(`${r}|${id}`);
              return (
                c
                && c.early >= cfg.minHoldVisits
                && c.held >= c.early * cfg.holdShare
              );
            }),
          )
          .map((s) => s.id),
      );
      const toBand = (a: Acc): BandProfile | null => {
        const pace = [...a.time].map((t, i) =>
          a.metres[i]! >= cfg.minBinMetres ? t / a.metres[i]! : null,
        );
        const dwell: Record<string, number> = {};
        for (const [stop, s] of a.stands) {
          // Where buses hold: what those that don't wait for the timetable stand there.
          const from = holds.has(stop) ? a.late.get(stop) : s;
          if (from && from.n >= cfg.minStopPasses)
            dwell[stop] = from.total / from.n;
        }
        this.moveExcessToDwell(pace, dwell, stops, holds);
        const rounded = pace.map((p) =>
          p === null ? null : Math.round(p * 1000) / 1000,
        );
        for (const k of Object.keys(dwell)) dwell[k] = Math.round(dwell[k]!);
        return rounded.some((x) => x !== null) || Object.keys(dwell).length ?
            { pace: rounded, dwell }
          : null;
      };
      const all = toBand(accs[accs.length - 1]!);
      if (!all) continue;
      shapes[shape] = {
        bands: accs.slice(0, -1).map(toBand),
        all,
        ...(holds.size ? { holds: [...holds].sort() } : {}),
      };
    }
    return {
      feedVersion: pp.plan.feedVersion,
      builtAt: new Date().toISOString(),
      binM: cfg.binM,
      bandStartHours: cfg.bandStartHours,
      hours: [...this.hours].sort(),
      shapes,
    };
  }

  /**
   * Moves slow time around stops (vs the pace nearby) from the bins into the stops' dwells. Around a
   * stop where buses hold, the slow time is the hold, which prediction adds itself: it's dropped.
   */
  private moveExcessToDwell(
    pace: (number | null)[],
    dwell: Record<string, number>,
    stops: { id: string; along: number }[],
    holds: ReadonlySet<string>,
  ): void {
    const { binM, stopExcessM, baselineWindowM } = this.cfg;
    const nearest = pace.map((_, b) => {
      const mid = (b + 0.5) * binM;
      let best: { id: string; along: number } | undefined;
      for (const s of stops)
        if (
          Math.abs(s.along - mid) <= stopExcessM
          && (!best || Math.abs(s.along - mid) < Math.abs(best.along - mid))
        )
          best = s;
      return best;
    });
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)]! : undefined;
    };
    const away = pace.flatMap((p, b) => (p !== null && !nearest[b] ? [p] : []));
    const overall = median(away);
    const w = Math.round(baselineWindowM / binM);
    pace.forEach((p, b) => {
      const stop = nearest[b];
      if (p === null || !stop || dwell[stop.id] === undefined) return;
      const local: number[] = [];
      for (
        let k = Math.max(0, b - w);
        k <= Math.min(pace.length - 1, b + w);
        k++
      )
        if (pace[k] !== null && !nearest[k]) local.push(pace[k]!);
      const base = median(local) ?? overall;
      if (base === undefined || p <= base) return;
      if (!holds.has(stop.id)) dwell[stop.id]! += (p - base) * binM;
      pace[b] = base;
    });
  }

  /** A pair of fixes on a trip ≤ maxPairS apart, at d0 then d1 along its shape. */
  private addPair(
    run: TripRun,
    length: number,
    d0: number,
    d1: number,
    t0: number,
    t1: number,
  ): void {
    const { cfg } = this;
    const trip = run.trip;
    const dt = (t1 - t0) / 1000;
    const bins = Math.ceil(length / cfg.binM);
    const accs = this.accFor(trip.pattern.shape, trip);
    const band = bandOf(
      cfg.bandStartHours,
      localHour(t0, this.pp.plan.timezone),
    );
    const targets = [accs[band]!, accs[accs.length - 1]!];
    if (d1 - d0 < cfg.stationaryM) {
      const mid = (d0 + d1) / 2;
      const dist = trip.pattern.dist;
      let stop = -1;
      for (let i = 0; i < dist.length; i++)
        if (
          Math.abs(dist[i]! - mid) <= cfg.stopZoneM
          && (stop < 0
            || Math.abs(dist[i]! - mid) < Math.abs(dist[stop]! - mid))
        )
          stop = i;
      if (stop >= 0) {
        // Dwelling: only after the trip's scheduled start (before it, the bus is laying over).
        const startMs = run.dayStartMs + trip.dep[0]! * 1000;
        let v = run.visits.get(stop);
        if (!v && stop >= run.next)
          run.visits.set(stop, (v = { standS: 0, firstMs: t0, lastMs: t1 }));
        if (v) v.standS += Math.max(0, t1 - Math.max(t0, startMs)) / 1000;
        return;
      }
      for (const a of targets)
        a.time[Math.min(bins - 1, Math.floor(mid / cfg.binM))]! += dt;
      return;
    }
    // Moving: spread time over bins by distance.
    for (
      let b = Math.floor(d0 / cfg.binM);
      b <= Math.min(bins - 1, Math.floor(d1 / cfg.binM));
      b++
    ) {
      const overlap =
        Math.min(d1, (b + 1) * cfg.binM) - Math.max(d0, b * cfg.binM);
      if (overlap <= 0) continue;
      for (const a of targets) {
        a.time[b]! += (dt * overlap) / (d1 - d0);
        a.metres[b]! += overlap;
      }
    }
  }
}

function addStand(m: Map<string, Stands>, stop: string, s: number): void {
  const st = m.get(stop);
  if (st) {
    st.n++;
    st.total += s;
  } else m.set(stop, { n: 1, total: s });
}
/**
 * What a pattern's trips share in a band (with the same stops skipped): the profile's pace per bin
 * and dwell per stop.
 */
interface CourseBase {
  binM: number;
  length: number;
  /** s/m per bin; NaN where the profile has no pace (the trip's timetable gives it: Course.hop). */
  pace: Float64Array;
  /** Stops in order: along (m), expected dwell (s), and whether buses hold there. */
  stops: { along: number; dwell: number; hold: boolean }[];
  /** The pattern's stops' distances along it (m). */
  dist: readonly number[];
}

/** A trip's travel plan along its shape: its pattern's base, and its own timetable pace per hop. */
interface Course extends CourseBase {
  /** s/m between each stop and the next, from the timetable, for bins the profile has no pace for. */
  hop: Float64Array;
  /** The trip's departure from each stop (service-day s). */
  dep: Float64Array;
  /** Per stop, the service-day second before which a bus doesn't leave it; NaN: no hold. */
  holdUntil: Float64Array;
}

/** Pace (s/m) in bin b of a course: the profile's, else the timetable's for the hop it's in. */
function paceAt(c: Course, b: number): number {
  const p = c.pace[b]!;
  if (!Number.isNaN(p)) return p;
  const along = (b + 0.5) * c.binM;
  let lo = 0;
  let hi = c.dist.length - 2;
  // The last hop starting at or before `along`.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.dist[mid]! <= along) lo = mid;
    else hi = mid - 1;
  }
  return c.hop[lo]!;
}

/** A Map keeping only the `max` most recently used entries. */
class RecentMap<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, v: V): void {
    this.map.set(key, v);
    if (this.map.size > this.max)
      this.map.delete(this.map.keys().next().value!);
  }
}

/**
 * Course bases and courses kept: enough for every pattern and trip running at once (TransLink's
 * peak: about 1,300 buses), in two bands near a band's start. They were kept for good once: about 3
 * KB per trip and band, 35 MB of heap by a weekday evening (2026-10-25).
 */
const MAX_COURSE_BASES = 2048;
const MAX_COURSES = 4096;

export interface WalkResult {
  along: number;
  /** Instantaneous speed (m/s); 0 while dwelling. */
  speed: number;
}

/** Service date (YYYYMMDD) of a trip running at an instant: after-midnight trips belong to the day before. */
export function tripServiceDate(
  trip: PreparedTrip,
  ms: number,
  tz: string,
): ServiceDate {
  const date = localDate(ms, tz);
  return (ms - serviceDayStart(date, tz)) / 1000 < trip.trip.start - 6 * 3600 ?
      addDays(date, -1)
    : date;
}

/** Stop ids a trip skips on a service date (GTFS-RT), if any. */
export type SkippedStops = (
  serviceDate: ServiceDate,
  tripId: string,
) => ReadonlySet<string> | undefined;

/** Walks buses forward along their trips with profile (or fallback) timings. */
export class Predictor {
  /** Course bases by pattern, band and stops skipped. */
  private bases = new RecentMap<string, CourseBase>(MAX_COURSE_BASES);
  /** Courses by trip, then as their bases. */
  private courses = new RecentMap<string, Course>(MAX_COURSES);

  private pp: PreparedPlan;
  private cfg: PredictionConfig;
  private bands: readonly (RtBandProfile | undefined)[];
  private skipped: SkippedStops | undefined;

  /** @param bands The profile by band, where loaded. */
  constructor(
    pp: PreparedPlan,
    cfg: PredictionConfig,
    bands: readonly (RtBandProfile | undefined)[] = [],
    skipped?: SkippedStops,
  ) {
    this.pp = pp;
    this.cfg = cfg;
    this.bands = bands;
    this.skipped = skipped;
  }

  /** The course for a trip at a local hour (cached per trip, band, and stops skipped that day). */
  course(trip: PreparedTrip, atMs: number): Course {
    const band = bandOf(
      this.cfg.bandStartHours,
      localHour(atMs, this.pp.plan.timezone),
    );
    const skip = this.skipped?.(
      tripServiceDate(trip, atMs, this.pp.plan.timezone),
      trip.trip.id,
    );
    const baseKey =
      skip?.size ?
        `${trip.trip.pattern}|${band}|${[...skip].sort().join(",")}`
      : `${trip.trip.pattern}|${band}`;
    const key = `${trip.trip.id}|${baseKey}`;
    let c = this.courses.get(key);
    if (!c) {
      let base = this.bases.get(baseKey);
      if (!base)
        this.bases.set(baseKey, (base = this.buildBase(trip, band, skip)));
      c = {
        ...base,
        hop: this.hopPace(trip),
        dep: trip.dep,
        holdUntil: new Float64Array(base.stops.length).fill(NaN),
      };
      this.holdTimes(trip, c);
      this.courses.set(key, c);
    }
    return c;
  }

  /** When the trip's bus leaves the stops where buses hold (holdDeparture). */
  private holdTimes(trip: PreparedTrip, c: Course): void {
    c.stops.forEach((s, i) => {
      if (s.hold) c.holdUntil[i] = holdDeparture(trip, i);
    });
  }

  private buildBase(
    trip: PreparedTrip,
    band: number,
    skip?: ReadonlySet<string>,
  ): CourseBase {
    const { cfg, pp } = this;
    const cum = pp.shapeCum.get(trip.pattern.shape);
    const length =
      cum ?
        cum[cum.length - 1]!
      : trip.pattern.dist[trip.pattern.dist.length - 1]!;
    const bp = this.bands[band];
    const binM = bp?.binM ?? cfg.binM;
    const bins = Math.max(1, Math.ceil(length / binM));
    const sp = bp?.shapes.get(trip.pattern.shape);
    const dist = trip.pattern.dist;
    const ids = trip.pattern.stops.map((si) => pp.plan.stops[si]!.id);
    const pace = new Float64Array(bins);
    for (let b = 0; b < bins; b++) pace[b] = sp?.pace[b] ?? NaN;
    const stops = ids.map((id, i) => {
      const k = sp ? sp.stops.indexOf(id) : -1;
      return {
        along: dist[i]!,
        dwell:
          skip?.has(id) ? 0
          : k >= 0 ? sp!.dwell[k]!
          : cfg.defaultDwellS,
        hold: !skip?.has(id) && Boolean(sp?.holds.has(id)),
      };
    });
    return { binM, length, pace, stops, dist };
  }

  /** Timetable fallback per hop: running time between stops, less a default dwell, spread by distance. */
  private hopPace(trip: PreparedTrip): Float64Array {
    const { cfg } = this;
    const dist = trip.pattern.dist;
    const hop = new Float64Array(Math.max(1, dist.length - 1)).fill(
      1 / cfg.defaultSpeedMps,
    );
    for (let i = 0; i < dist.length - 1; i++) {
      const dd = dist[i + 1]! - dist[i]!;
      const dt = trip.arr[i + 1]! - trip.dep[i]! - cfg.defaultDwellS;
      hop[i] = dd > 0 && dt > 0 ? dt / dd : 1 / cfg.defaultSpeedMps;
    }
    return hop;
  }

  /** Profile time (s) to go from along a0 to a1, including dwells at stops in (a0, a1]. */
  timeBetween(c: Course, a0: number, a1: number): number {
    let t = 0;
    let d = a0;
    while (d < a1 - 1e-6) {
      const b = Math.min(c.pace.length - 1, Math.floor(d / c.binM));
      const end = Math.min(a1, (b + 1) * c.binM);
      t += (end - d) * paceAt(c, b);
      d = end;
    }
    for (const s of c.stops)
      if (s.along > a0 && s.along <= a1 && s.dwell >= this.cfg.minDwellS)
        t += s.dwell;
    return t;
  }

  /**
   * Position after `seconds` from along a0, with every time scaled by `factor`. Stops at or before
   * a0 are behind the bus. With `at`, the service-day second it was at a0, buses hold to the
   * timetable: before its trip's start, a bus stands where it is until its departure from there (the
   * stop it's at, else the one behind it), and it doesn't leave a stop it holds at (holdUntil) before
   * time. Without it (fitting a walk between two fixes, or the paced schedule), dwells only.
   */
  walk(
    c: Course,
    a0: number,
    seconds: number,
    factor = 1,
    at?: number,
  ): WalkResult {
    let left = seconds;
    let d = a0;
    let si = c.stops.findIndex((s) => s.along > a0);
    if (si < 0) si = c.stops.length;
    if (at !== undefined && at < c.dep[0]!) {
      let k = 0;
      while (
        k + 1 < c.stops.length
        && c.stops[k + 1]!.along <= a0 + this.cfg.stopZoneM
      )
        k++;
      const wait = c.dep[k]! - at;
      if (wait >= left) return { along: a0, speed: 0 };
      if (wait > 0) left -= wait;
      si = Math.max(si, k + 1);
    }
    while (left > 0 && d < c.length) {
      const next = si < c.stops.length ? c.stops[si]! : undefined;
      if (next && next.along <= d + 1e-6) {
        let dwell = next.dwell >= this.cfg.minDwellS ? next.dwell * factor : 0;
        const until = c.holdUntil[si]!;
        if (at !== undefined && !Number.isNaN(until))
          dwell = Math.max(dwell, until - (at + seconds - left));
        if (left < dwell) return { along: d, speed: 0 };
        left -= dwell;
        si++;
        continue;
      }
      const b = Math.min(c.pace.length - 1, Math.floor(d / c.binM));
      const end = Math.min(
        c.length,
        (b + 1) * c.binM,
        next ? next.along : Infinity,
      );
      const pace = paceAt(c, b) * factor;
      const need = (end - d) * pace;
      if (need >= left) return { along: d + left / pace, speed: 1 / pace };
      left -= need;
      d = end;
    }
    return { along: Math.min(d, c.length), speed: 0 };
  }

  /** Timetable anchors per trip course. */
  private anchors = new WeakMap<
    Course,
    { along: number; sec: number; factor: number }[]
  >();

  /**
   * Paces bus trips between their timetable times with the profile (stopping at stops), for schedule
   * estimates: the bus arrives at each anchor stop on time and leaves when the timetable says.
   */
  readonly pacer: TripPacer = (trip, sec, serviceDate) => {
    if (trip.route.kind !== "bus") return undefined;
    return this.paceOn(
      trip,
      this.course(
        trip,
        serviceDayStart(serviceDate, this.pp.plan.timezone) + sec * 1000,
      ),
      sec,
    );
  };

  /** The pacer on a course already looked up (`course` is most of a pacer call's cost). */
  private paceOn(
    trip: PreparedTrip,
    c: Course,
    sec: number,
  ): { along: number; speed: number } {
    let spans = this.anchors.get(c);
    if (!spans) this.anchors.set(c, (spans = this.buildAnchors(trip, c)));
    let k = spans.length - 2;
    while (k > 0 && spans[k]!.sec > sec) k--;
    const a = spans[k]!;
    const b = spans[k + 1]!;
    const w = this.walk(c, a.along, sec - a.sec, a.factor);
    return {
      along: Math.min(b.along, w.along),
      speed: w.along >= b.along ? 0 : w.speed,
    };
  }

  /**
   * Delay (s, + late) of a bus at `along` at service-day second `sec` on a trip, against where the
   * paced schedule has it. Standing at a stop in the schedule spans an interval: being there any time
   * within it is on time.
   */
  delayAt(
    trip: PreparedTrip,
    along: number,
    sec: number,
    serviceDate: ServiceDate,
  ): number {
    const lo = trip.dep[0]!;
    const hi = trip.arr[trip.arr.length - 1]!;
    const dayStart = serviceDayStart(serviceDate, this.pp.plan.timezone);
    // The course by service-day hour (`course` is most of a pacer call's cost, and the search makes
    // dozens): a course changes only with the local hour (its band), and a service day starts on a
    // local hour (noon − 12 h), so every second of a service-day hour has the same one.
    const courses = new Map<number, Course>();
    const alongAt = (s: number): number => {
      if (s <= lo) return trip.pattern.dist[0]!;
      if (s >= hi) return trip.pattern.dist[trip.pattern.dist.length - 1]!;
      if (trip.route.kind === "bus") {
        const h = Math.floor(s / 3600);
        let c = courses.get(h);
        if (!c)
          courses.set(h, (c = this.course(trip, dayStart + h * 3600_000)));
        return this.paceOn(trip, c, s).along;
      }
      // Not paced: linear between stops.
      let i = 0;
      while (i < trip.arr.length - 2 && trip.arr[i + 1]! <= s) i++;
      const f =
        (s - trip.dep[i]!) / Math.max(1, trip.arr[i + 1]! - trip.dep[i]!);
      return (
        trip.pattern.dist[i]!
        + f * (trip.pattern.dist[i + 1]! - trip.pattern.dist[i]!)
      );
    };
    // First and last scheduled second at which the bus is at `along` (alongAt is non-decreasing).
    const search = (pred: (s: number) => boolean) => {
      let a = lo;
      let b = hi;
      for (let k = 0; k < 40 && b - a > 0.05; k++) {
        const m = (a + b) / 2;
        if (pred(m)) b = m;
        else a = m;
      }
      return b;
    };
    const first = search((s) => alongAt(s) >= along - 0.05);
    const last = search((s) => alongAt(s) > along + 0.05);
    return (
      sec < first ? sec - first
      : sec > last ? sec - last
      : 0
    );
  }

  private buildAnchors(
    trip: PreparedTrip,
    c: Course,
  ): { along: number; sec: number; factor: number }[] {
    const dist = trip.pattern.dist;
    const n = dist.length;
    const idx = [0];
    for (let i = 1; i < n - 1; i++)
      if (
        trip.dep[i]! - trip.dep[idx[idx.length - 1]!]!
        >= this.cfg.scheduleAnchorS
      )
        idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return idx.map((i, j) => {
      const next = idx[j + 1];
      if (next === undefined)
        return { along: dist[i]!, sec: trip.arr[i]!, factor: 1 };
      const expected = this.timeBetween(c, dist[i]!, dist[next]!);
      const available = trip.arr[next]! - trip.dep[i]!;
      return {
        along: dist[i]!,
        sec: trip.dep[i]!,
        factor: expected > 0 && available > 0 ? available / expected : 1,
      };
    });
  }

  /** How this bus is running vs the profile, from its recent fixes (factor on profile times). */
  paceFactor(c: Course, recent: { along: number; ts: number }[]): number {
    if (recent.length < 2) return 1;
    const a = recent[0]!;
    const b = recent[recent.length - 1]!;
    const expected = this.timeBetween(c, a.along, b.along);
    const actual = (b.ts - a.ts) / 1000;
    if (
      expected <= 0
      || actual <= 0
      || b.along - a.along < this.cfg.stationaryM
    )
      return 1;
    const r = 1 + this.cfg.paceWeight * (actual / expected - 1);
    return Math.min(this.cfg.paceClamp[1], Math.max(this.cfg.paceClamp[0], r));
  }
}
