// Play back movement files: train positions on the track graph as a pure function of
// (movements, plan, time) (PLAN.md §4.4). Revenue trips take their times from the service plan
// (with the same modelled dwell as the schedule engine) and their paths from the routed patterns.

import type { LonLat } from '../geo.ts';
import type { Dir, TrackGraph, TrackPos } from '../infra/graph.ts';
import type { PreparedPlan, VehicleState, VehicleStatus } from '../schedule/engine.ts';
import { distanceAt, kinematicsFor, solveLeg, speedAt, type Kinematics, type KinematicsConfig, type LegProfile } from './kinematics.ts';
import type { MovementsFile, Run, RunEvent } from './types.ts';

interface DecodedPath {
  segs: string[];
  from: number[];
  to: number[];
  /** Cumulative distance at the start of each piece. */
  cum: number[];
  length: number;
}

interface TimedEvent {
  e: RunEvent;
  t0: number;
  t1: number;
}

interface PreparedRun {
  run: Run;
  events: TimedEvent[];
  start: number;
  end: number;
  kin: Kinematics;
  deadheadKin: Kinematics;
}

export interface PlaybackOptions {
  deadheadSpeedFactor: number;
  /** Draw each train as a polyline following the track (for zoomed-in views). */
  shapes?: boolean;
}

export class TrainPlayback {
  private paths: DecodedPath[];
  private runs: PreparedRun[];
  private legCache = new Map<string, LegProfile>();

  constructor(
    readonly file: MovementsFile,
    private pp: PreparedPlan,
    private g: TrackGraph,
    kin: KinematicsConfig,
    private opts: PlaybackOptions,
  ) {
    this.paths = file.paths.map((packed) => {
      const segs: string[] = [];
      const from: number[] = [];
      const to: number[] = [];
      const cum: number[] = [];
      let length = 0;
      for (let i = 0; i < packed.length; i += 3) {
        segs.push(file.segIds[packed[i]!]!);
        from.push(packed[i + 1]!);
        to.push(packed[i + 2]!);
        cum.push(length);
        length += Math.abs(packed[i + 2]! - packed[i + 1]!);
      }
      return { segs, from, to, cum, length };
    });
    this.runs = file.runs
      .map((run) => {
        const k = kinematicsFor(kin, 'skytrain', run.line);
        const events: TimedEvent[] = run.events.map((e) => {
          if (e.k !== 'trip') return { e, t0: e.t0, t1: e.t1 };
          const t = pp.tripIndex.get(e.trip);
          if (!t) throw new Error(`Movement file references unknown trip ${e.trip}`);
          return { e, t0: t.dep[0]!, t1: t.arr[t.arr.length - 1]! };
        });
        return {
          run,
          events,
          start: events[0]?.t0 ?? 0,
          end: events[events.length - 1]?.t1 ?? 0,
          kin: k,
          deadheadKin: { ...k, maxSpeed: k.maxSpeed * opts.deadheadSpeedFactor, minCruiseFraction: 0.5 },
        };
      })
      .sort((a, b) => a.start - b.start);
  }

  /** Trains visible at `sec` (service-day seconds) of this file's service day. */
  vehiclesAt(sec: number, serviceDate: string, routes?: Set<string>): VehicleState[] {
    const out: VehicleState[] = [];
    for (const r of this.runs) {
      if (r.start > sec) break;
      if (sec > r.end) continue;
      const v = this.runAt(r, sec, serviceDate);
      if (v && (!routes || routes.has(v.routeKey))) out.push(v);
    }
    return out;
  }

  private runAt(r: PreparedRun, sec: number, serviceDate: string): VehicleState | undefined {
    // Last event starting at or before sec.
    let lo = 0;
    let hi = r.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r.events[mid]!.t0 <= sec) lo = mid;
      else hi = mid - 1;
    }
    const te = r.events[lo]!;
    const e = te.e;
    const base = {
      id: `${serviceDate}:${r.run.id}`,
      provenance: 'estimated' as const,
      source: `timetable ${this.pp.plan.feedVersion} + run inference`,
      serviceDate,
      length: r.kin.length,
      width: r.kin.width,
    };
    if (e.k === 'hold') {
      const pos = { seg: this.file.segIds[e.seg]!, offset: e.offset };
      return this.state(r, base, pos, e.dir, e.kind === 'yard' ? 'layover' : 'layover', undefined, this.nextTripHeadsign(r, lo), 0);
    }
    if (e.k === 'move') {
      const path = this.paths[e.path]!;
      const leg = this.leg(e.path, e.t1 - e.t0, r.deadheadKin);
      const tt = Math.min(e.t1 - e.t0, Math.max(0, sec - e.t0));
      const d = distanceAt(leg, tt);
      const { pos, dir } = this.along(path, d);
      const status: VehicleStatus = e.kind;
      const headsign = e.kind === 'pullin' ? 'Not in service · to yard' : e.kind === 'pullout' ? 'Not in service · from yard' : 'Turning back';
      return this.state(r, base, pos, dir, status, undefined, headsign, speedAt(leg, tt));
    }
    // Revenue trip.
    const t = this.pp.tripIndex.get(e.trip)!;
    const pat = this.file.patterns[e.pattern]!;
    const n = t.arr.length;
    const hopPath = (i: number) => (i === 0 && e.berth ? e.berth.hop : i === n - 2 && e.arrive ? e.arrive.hop : pat.hops[i]!);
    const stopPos = (i: number): { pos: TrackPos; dir: Dir } => {
      if (i === 0 && e.berth) return { pos: { seg: this.file.segIds[e.berth.seg]!, offset: e.berth.offset }, dir: e.berth.dir };
      if (i === n - 1 && e.arrive) return { pos: { seg: this.file.segIds[e.arrive.seg]!, offset: e.arrive.offset }, dir: e.arrive.dir };
      if (i < n - 1) return this.along(this.paths[hopPath(i)]!, 0);
      const p = this.paths[hopPath(n - 2)]!;
      return this.along(p, p.length);
    };
    let i = 0;
    let hiI = n - 1;
    while (i < hiI) {
      const mid = (i + hiI + 1) >> 1;
      if (t.arr[mid]! <= sec) i = mid;
      else hiI = mid - 1;
    }
    const headsign = t.trip.headsign;
    if (sec <= t.dep[i]! || i === n - 1) {
      const { pos, dir } = stopPos(i);
      return this.state(r, base, pos, dir, 'dwell', this.pp.plan.stops[t.pattern.stops[i]!]!.name, headsign, 0, t.trip.id, t.route.key);
    }
    const pi = hopPath(i);
    const path = this.paths[pi]!;
    const leg = this.leg(pi, t.arr[i + 1]! - t.dep[i]!, r.kin);
    const tt = sec - t.dep[i]!;
    const d = distanceAt(leg, tt);
    const { pos, dir } = this.along(path, d);
    const holding = tt < leg.hold;
    return this.state(
      r,
      base,
      pos,
      dir,
      holding ? 'dwell' : 'moving',
      this.pp.plan.stops[t.pattern.stops[holding ? i : i + 1]!]!.name,
      headsign,
      speedAt(leg, tt),
      t.trip.id,
      t.route.key,
    );
  }

  private nextTripHeadsign(r: PreparedRun, from: number): string {
    for (let j = from + 1; j < r.events.length; j++) {
      const e = r.events[j]!.e;
      if (e.k === 'trip') return this.pp.tripIndex.get(e.trip)?.trip.headsign ?? '';
    }
    return 'Not in service';
  }

  private leg(path: number, duration: number, k: Kinematics): LegProfile {
    const key = `${path}|${duration}|${k.maxSpeed}`;
    let l = this.legCache.get(key);
    if (!l) this.legCache.set(key, (l = solveLeg(this.paths[path]!.length, duration, k)));
    return l;
  }

  /** Track position `d` metres along a decoded path. */
  private along(p: DecodedPath, d: number): { pos: TrackPos; dir: Dir } {
    let i = 0;
    while (i < p.segs.length - 1 && p.cum[i + 1]! <= d) i++;
    const from = p.from[i]!;
    const to = p.to[i]!;
    const dir: Dir = to >= from ? 1 : -1;
    const into = Math.min(Math.abs(to - from), Math.max(0, d - p.cum[i]!));
    return { pos: { seg: p.segs[i]!, offset: from + dir * into }, dir };
  }

  private state(
    r: PreparedRun,
    base: Pick<VehicleState, 'id' | 'provenance' | 'source' | 'serviceDate' | 'length' | 'width'>,
    pos: TrackPos,
    dir: Dir,
    status: VehicleStatus,
    stopName: string | undefined,
    headsign: string,
    speed: number,
    tripId = '',
    routeKey = r.run.line,
  ): VehicleState {
    const p = this.g.pointAt(pos, dir);
    const v: VehicleState = {
      ...base,
      routeKey,
      mode: 'skytrain',
      tripId,
      headsign,
      lon: p.lon,
      lat: p.lat,
      bearing: p.bearing,
      speed,
      status,
      runId: r.run.id,
      track: { seg: pos.seg, offset: pos.offset },
    };
    if (stopName) v.stopName = stopName;
    if (this.opts.shapes) {
      const half = r.kin.length / 2;
      const back = this.g.walk(pos, (-dir) as Dir, half);
      const fwd = this.g.walk(pos, dir, half);
      v.shape = [...back.reverse(), ...fwd.slice(1)] as LonLat[];
    }
    return v;
  }
}
