// Bus travel-time profiles learned from recorded GTFS-RT positions, and a predictor that walks a bus
// forward along its trip with them (packages/transit-core/DESIGN.md#buses).
//
// Profile, per trip shape and time-of-day band:
//  - pace (s/m) per bin along the shape, from consecutive fixes of the same trip. Time between two
//    fixes is spread over the bins between them in proportion to distance; a bus that didn't move
//    (< stationaryM) near a stop is dwelling there, elsewhere it is held in traffic or at a signal
//    and that time stays in the bin's pace.
//  - expected dwell (s) per stop: dwell time seen / passes, plus the extra time spent around the stop
//    compared with the pace nearby. With fixes ~30 s apart most dwells aren't seen as standing still:
//    they show up as slow bins around the stop instead, so that excess is moved into the dwell (and
//    those bins get the nearby pace), which is what makes predicted buses visibly stop.
// Totals are preserved: pace × distance + dwells ≈ observed running time.
//
// Prediction: from a fix, walk bin by bin, stopping at each upcoming stop for its expected dwell,
// scaled by how this bus has been running relative to the profile. Gaps fall back to the all-day
// profile, then to the timetable, then to a default speed. Stops TransLink reports as skipped by a
// trip (GTFS-RT, e.g. on a detour) get no dwell.

import { cumulativeLengths, projectOnto, type LonLat } from "../geo.ts";
import type {
  PreparedPlan,
  PreparedTrip,
  TripPacer,
} from "../schedule/engine.ts";
import { addDays, localDate, serviceDayStart, toWallTime } from "../time.ts";
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
  /** A stop's dwell is used once this many passes were seen. */
  minStopPasses: number;
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
}

export interface RtProfileFile {
  schema: 1;
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

interface Acc {
  time: Float64Array;
  metres: Float64Array;
  dwell: Map<string, number>;
  passes: Map<string, number>;
}

/** Accumulates fixes into profiles. Feed it snapshots (any order within a vehicle's day), then build(). */
export class ProfileBuilder {
  private acc = new Map<string, Acc[]>(); // shape → per band (+1 for all-day)
  private fixes = new Map<string, RtVehicle[]>();
  /** Shape → its stops (id, along), from the trips seen on it. */
  private shapeStops = new Map<string, Map<string, number>>();
  private hours = new Set<string>();

  private pp: PreparedPlan;
  private cfg: PredictionConfig;

  constructor(pp: PreparedPlan, cfg: PredictionConfig) {
    this.pp = pp;
    this.cfg = cfg;
  }

  add(snapshots: RtSnapshot[], hourLabel?: string): void {
    if (hourLabel) this.hours.add(hourLabel);
    for (const s of snapshots)
      for (const v of s.vehicles) {
        if (!v.tripId) continue;
        let list = this.fixes.get(v.id);
        if (!list) this.fixes.set(v.id, (list = []));
        list.push(v);
      }
  }

  private accFor(shape: string, bins: number): Acc[] {
    let a = this.acc.get(shape);
    if (!a) {
      a = Array.from({ length: this.cfg.bandStartHours.length + 1 }, () => ({
        time: new Float64Array(bins),
        metres: new Float64Array(bins),
        dwell: new Map(),
        passes: new Map(),
      }));
      this.acc.set(shape, a);
    }
    return a;
  }

  build(): RtProfileFile {
    const { cfg, pp } = this;
    const tz = pp.plan.timezone;
    for (const list of this.fixes.values()) {
      list.sort((a, b) => a.ts - b.ts);
      let prev: { v: RtVehicle; along: number } | undefined;
      for (const v of list) {
        if (prev && v.ts === prev.v.ts) continue;
        const trip = pp.tripIndex.get(v.tripId!);
        const coords =
          trip && (pp.plan.shapes[trip.pattern.shape] as LonLat[] | undefined);
        if (!trip || !coords) {
          prev = undefined;
          continue;
        }
        const cum =
          pp.shapeCum.get(trip.pattern.shape) ?? cumulativeLengths(coords);
        const sameTrip = prev && prev.v.tripId === v.tripId;
        const p = projectOnto(
          coords,
          cum,
          [v.lon, v.lat],
          sameTrip ? Math.max(0, prev!.along - 50) : 0,
        );
        if (p.offset > cfg.maxOffsetM) {
          prev = undefined;
          continue;
        }
        if (
          prev
          && sameTrip
          && (v.ts - prev.v.ts) / 1000 <= cfg.maxPairS
          && p.along >= prev.along - cfg.stationaryM
        ) {
          this.addPair(
            trip,
            cum[cum.length - 1]!,
            prev.along,
            p.along,
            (v.ts - prev.v.ts) / 1000,
            bandOf(cfg.bandStartHours, localHour(prev.v.ts, tz)),
          );
        }
        prev = { v, along: p.along };
      }
    }
    const shapes: Record<string, ShapeProfile> = {};
    for (const [shape, accs] of this.acc) {
      const stops = [...(this.shapeStops.get(shape) ?? [])].map(
        ([id, along]) => ({ id, along }),
      );
      const toBand = (a: Acc): BandProfile | null => {
        const pace = [...a.time].map((t, i) =>
          a.metres[i]! >= cfg.minBinMetres ? t / a.metres[i]! : null,
        );
        const dwell: Record<string, number> = {};
        for (const [stop, passes] of a.passes)
          if (passes >= cfg.minStopPasses)
            dwell[stop] = (a.dwell.get(stop) ?? 0) / passes;
        this.moveExcessToDwell(pace, dwell, stops);
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
      shapes[shape] = { bands: accs.slice(0, -1).map(toBand), all };
    }
    return {
      schema: 1,
      feedVersion: pp.plan.feedVersion,
      builtAt: new Date().toISOString(),
      binM: cfg.binM,
      bandStartHours: cfg.bandStartHours,
      hours: [...this.hours].sort(),
      shapes,
    };
  }

  /** Moves slow time around stops (vs the pace nearby) from the bins into the stops' dwells. */
  private moveExcessToDwell(
    pace: (number | null)[],
    dwell: Record<string, number>,
    stops: { id: string; along: number }[],
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
      dwell[stop.id]! += (p - base) * binM;
      pace[b] = base;
    });
  }

  private addPair(
    trip: PreparedTrip,
    length: number,
    d0: number,
    d1: number,
    dt: number,
    band: number,
  ): void {
    const { cfg } = this;
    const bins = Math.ceil(length / cfg.binM);
    const accs = this.accFor(trip.pattern.shape, bins);
    const targets = [accs[band]!, accs[accs.length - 1]!];
    const stops = trip.pattern.stops.map((si, i) => ({
      id: this.pp.plan.stops[si]!.id,
      along: trip.pattern.dist[i]!,
    }));
    let known = this.shapeStops.get(trip.pattern.shape);
    if (!known) this.shapeStops.set(trip.pattern.shape, (known = new Map()));
    for (const s of stops) known.set(s.id, s.along);
    if (d1 - d0 < cfg.stationaryM) {
      const mid = (d0 + d1) / 2;
      const stop = stops.find((s) => Math.abs(s.along - mid) <= cfg.stopZoneM);
      for (const a of targets) {
        if (stop) a.dwell.set(stop.id, (a.dwell.get(stop.id) ?? 0) + dt);
        else a.time[Math.min(bins - 1, Math.floor(mid / cfg.binM))]! += dt;
      }
      return;
    }
    // Moving: spread time over bins by distance; count passes of stops crossed.
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
    for (const s of stops)
      if (s.along > d0 && s.along <= d1)
        for (const a of targets)
          a.passes.set(s.id, (a.passes.get(s.id) ?? 0) + 1);
  }
}

/** A trip's travel plan along its shape: pace per bin and dwell per stop. */
interface Course {
  binM: number;
  length: number;
  /** s/m per bin. */
  pace: Float64Array;
  /** Stops in order: along (m) and expected dwell (s). */
  stops: { along: number; dwell: number }[];
}

export interface WalkResult {
  along: number;
  /** Instantaneous speed (m/s); 0 while dwelling. */
  speed: number;
}

/** Service date (YYYYMMDD) of a trip running at an instant: after-midnight trips belong to the day before. */
export function tripServiceDate(trip: PreparedTrip, ms: number): string {
  const date = localDate(ms);
  return (ms - serviceDayStart(date)) / 1000 < trip.trip.start - 6 * 3600 ?
      addDays(date, -1)
    : date;
}

/** Stop ids a trip skips on a service date (GTFS-RT), if any. */
export type SkippedStops = (
  serviceDate: string,
  tripId: string,
) => ReadonlySet<string> | undefined;

/** Walks buses forward along their trips with profile (or fallback) timings. */
export class Predictor {
  private courses = new Map<string, Course>();

  private pp: PreparedPlan;
  private cfg: PredictionConfig;
  private profile: RtProfileFile | undefined;
  private skipped: SkippedStops | undefined;

  constructor(
    pp: PreparedPlan,
    cfg: PredictionConfig,
    profile?: RtProfileFile,
    skipped?: SkippedStops,
  ) {
    this.pp = pp;
    this.cfg = cfg;
    this.profile = profile;
    this.skipped = skipped;
  }

  /** The course for a trip at a local hour (cached per trip, band, and stops skipped that day). */
  course(trip: PreparedTrip, atMs: number): Course {
    const band = bandOf(
      this.cfg.bandStartHours,
      localHour(atMs, this.pp.plan.timezone),
    );
    const skip = this.skipped?.(tripServiceDate(trip, atMs), trip.trip.id);
    const key =
      skip?.size ?
        `${trip.trip.id}|${band}|${[...skip].sort().join(",")}`
      : `${trip.trip.id}|${band}`;
    let c = this.courses.get(key);
    if (!c) this.courses.set(key, (c = this.buildCourse(trip, band, skip)));
    return c;
  }

  private buildCourse(
    trip: PreparedTrip,
    band: number,
    skip?: ReadonlySet<string>,
  ): Course {
    const { cfg, pp } = this;
    const cum = pp.shapeCum.get(trip.pattern.shape);
    const length =
      cum ?
        cum[cum.length - 1]!
      : trip.pattern.dist[trip.pattern.dist.length - 1]!;
    const binM = this.profile?.binM ?? cfg.binM;
    const bins = Math.max(1, Math.ceil(length / binM));
    const sp = this.profile?.shapes[trip.pattern.shape];
    const bp = sp?.bands[band] ?? null;
    const dist = trip.pattern.dist;
    const ids = trip.pattern.stops.map((si) => pp.plan.stops[si]!.id);
    // Timetable fallback: running time between stops, less a default dwell, spread by distance.
    const ttPace = (along: number): number => {
      let i = 0;
      while (i < dist.length - 2 && dist[i + 1]! <= along) i++;
      const dd = dist[i + 1]! - dist[i]!;
      const dt = trip.arr[i + 1]! - trip.dep[i]! - cfg.defaultDwellS;
      return dd > 0 && dt > 0 ? dt / dd : 1 / cfg.defaultSpeedMps;
    };
    const pace = new Float64Array(bins);
    for (let b = 0; b < bins; b++)
      pace[b] = bp?.pace[b] ?? sp?.all.pace[b] ?? ttPace((b + 0.5) * binM);
    const stops = ids.map((id, i) => ({
      along: dist[i]!,
      dwell:
        skip?.has(id) ?
          0
        : (bp?.dwell[id] ?? sp?.all.dwell[id] ?? cfg.defaultDwellS),
    }));
    return { binM, length, pace, stops };
  }

  /** Profile time (s) to go from along a0 to a1, including dwells at stops in (a0, a1]. */
  timeBetween(c: Course, a0: number, a1: number): number {
    let t = 0;
    let d = a0;
    while (d < a1 - 1e-6) {
      const b = Math.min(c.pace.length - 1, Math.floor(d / c.binM));
      const end = Math.min(a1, (b + 1) * c.binM);
      t += (end - d) * c.pace[b]!;
      d = end;
    }
    for (const s of c.stops)
      if (s.along > a0 && s.along <= a1 && s.dwell >= this.cfg.minDwellS)
        t += s.dwell;
    return t;
  }

  /**
   * Position after `seconds` from along a0, with every time scaled by `factor`. Stops at or before
   * a0 are behind the bus; `servedTo` marks stops up to that along as already served too.
   */
  walk(
    c: Course,
    a0: number,
    seconds: number,
    factor = 1,
    servedTo = a0,
  ): WalkResult {
    let left = seconds;
    let d = a0;
    let si = c.stops.findIndex((s) => s.along > Math.max(a0, servedTo));
    if (si < 0) si = c.stops.length;
    while (left > 0 && d < c.length) {
      const next = si < c.stops.length ? c.stops[si]! : undefined;
      if (next && next.along <= d + 1e-6) {
        const dwell =
          next.dwell >= this.cfg.minDwellS ? next.dwell * factor : 0;
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
      const pace = c.pace[b]! * factor;
      const need = (end - d) * pace;
      if (need >= left) return { along: d + left / pace, speed: 1 / pace };
      left -= need;
      d = end;
    }
    return { along: Math.min(d, c.length), speed: 0 };
  }

  /** Timetable anchors per trip course (courses are per trip and time-of-day band). */
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
    const c = this.course(trip, serviceDayStart(serviceDate) + sec * 1000);
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
  };

  /**
   * Delay (s, + late) of a bus at `along` at service-day second `sec` on a trip, against where the
   * paced schedule has it. Standing at a stop in the schedule spans an interval: being there any time
   * within it is on time.
   */
  delayAt(
    trip: PreparedTrip,
    along: number,
    sec: number,
    serviceDate: string,
  ): number {
    const lo = trip.dep[0]!;
    const hi = trip.arr[trip.arr.length - 1]!;
    const alongAt = (s: number): number => {
      if (s <= lo) return trip.pattern.dist[0]!;
      if (s >= hi) return trip.pattern.dist[trip.pattern.dist.length - 1]!;
      const p = this.pacer(trip, s, serviceDate);
      if (p) return p.along;
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
