// Play back movement files: train positions on the track graph as a pure function of
// (movements, plan, time) (docs/skytrain-viz-PLAN.md §4.4). Revenue trips take their times from the service plan
// (with the same modelled dwell as the schedule engine) and their paths from the routed patterns.

import type { LonLat } from "../geo.ts";
import type { Dir, TrackGraph, TrackPos } from "../infra/graph.ts";
import type {
  PreparedPlan,
  VehicleState,
  VehicleStatus,
} from "../schedule/engine.ts";
import {
  distanceAt,
  kinematicsFor,
  solveLeg,
  speedAt,
  type Kinematics,
  type KinematicsConfig,
  type LegProfile,
} from "./kinematics.ts";
import type { HopWait, MovementsFile, Run, RunEvent } from "./types.ts";
import {
  OBSERVED_WINDOW_S,
  type ParkedTrain,
} from "../corrections/reconcile.ts";
import { formatServiceTime, serviceDayStart } from "../time.ts";

/** Distance and speed at `sec` along a flattened [t, d, …] trajectory (linear between points). */
function alongVia(pts: number[], sec: number): { d: number; speed: number } {
  const n = pts.length / 2;
  if (sec <= pts[0]!) return { d: pts[1]!, speed: 0 };
  if (sec >= pts[2 * n - 2]!) return { d: pts[2 * n - 1]!, speed: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[2 * mid]! <= sec) lo = mid;
    else hi = mid;
  }
  const t0 = pts[2 * lo]!;
  const d0 = pts[2 * lo + 1]!;
  const t1 = pts[2 * hi]!;
  const d1 = pts[2 * hi + 1]!;
  const speed = t1 > t0 ? (d1 - d0) / (t1 - t0) : 0;
  return { d: d0 + speed * (sec - t0), speed };
}

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
  /** Trip stop times: the dispatcher's when set, else the plan's. */
  arr?: ArrayLike<number>;
  dep?: ArrayLike<number>;
}

interface PreparedRun {
  run: Run;
  events: TimedEvent[];
  start: number;
  end: number;
  kin: Kinematics;
  deadheadKin: Kinematics;
  turnbackKin: Kinematics;
}

export interface PlaybackOptions {
  deadheadSpeedFactor: number;
  /** Speed factor for turnback moves (default: deadheadSpeedFactor). */
  turnbackSpeedFactor?: number;
  /** Draw each train as a polyline following the track (for zoomed-in views). */
  shapes?: boolean;
}

export class TrainPlayback {
  private paths: DecodedPath[];
  private runs: PreparedRun[];
  private legCache = new Map<string, LegProfile>();
  private kin: (line: string) => Kinematics;

  constructor(
    readonly file: MovementsFile,
    private pp: PreparedPlan,
    private g: TrackGraph,
    kin: KinematicsConfig,
    private opts: PlaybackOptions,
  ) {
    this.kin = (line) => kinematicsFor(kin, "skytrain", line);
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
        const k = kinematicsFor(kin, "skytrain", run.line);
        const events: TimedEvent[] = run.events.map((e) => {
          if (e.k !== "trip") return { e, t0: e.t0, t1: e.t1 };
          const t = pp.tripIndex.get(e.trip);
          if (!t)
            throw new Error(`Movement file references unknown trip ${e.trip}`);
          if (!e.times)
            return {
              e,
              t0: t.dep[0]!,
              t1: t.arr[t.arr.length - 1]!,
              arr: t.arr,
              dep: t.dep,
            };
          const arr = e.times.filter((_, i) => i % 2 === 0);
          const dep = e.times.filter((_, i) => i % 2 === 1);
          return { e, t0: dep[0]!, t1: arr[arr.length - 1]!, arr, dep };
        });
        return {
          run,
          events,
          start: events[0]?.t0 ?? 0,
          end: events[events.length - 1]?.t1 ?? 0,
          kin: k,
          deadheadKin: {
            ...k,
            maxSpeed: k.maxSpeed * opts.deadheadSpeedFactor,
            minCruiseFraction: 0.5,
          },
          turnbackKin: {
            ...k,
            maxSpeed:
              k.maxSpeed
              * (opts.turnbackSpeedFactor ?? opts.deadheadSpeedFactor),
            minCruiseFraction: 0.5,
          },
        };
      })
      .sort((a, b) => a.start - b.start);
  }

  /**
   * Trains visible at `sec` (service-day seconds) of this file's service day. With a dispatch patch
   * applied (docs/skytrain-viz-PLAN.md §4.11), runs carry their observations: positions within 90 s of a sighting are
   * observed, times moved by observations or disruptions interpolated.
   */
  vehiclesAt(
    sec: number,
    serviceDate: string,
    routes?: Set<string>,
  ): VehicleState[] {
    const out: VehicleState[] = [];
    for (const r of this.runs) {
      if (r.start > sec) break;
      if (sec > r.end) continue;
      const v = this.runAt(r, sec, serviceDate);
      if (!v || (routes && !routes.has(v.routeKey))) continue;
      const run = r.run;
      if (v.tripId && run.cancelled?.includes(v.tripId)) continue;
      const near = run.observed?.find(
        (o) => Math.abs(o.t - sec) <= OBSERVED_WINDOW_S,
      );
      const adjusted = run.adjusted?.some(([a, b]) => sec >= a && sec <= b);
      if (near || adjusted) {
        v.provenance = near ? "observed" : "interpolated";
        if (run.sources?.length)
          v.source = `${run.sources.join(", ")} + ${v.source}`;
        if (near) v.observedAt = serviceDayStart(serviceDate) + near.t * 1000;
      }
      if (run.consist) v.consist = run.consist;
      const note = run.notes?.find((n) => sec >= n.t0 && sec <= n.t1);
      if (note) v.note = v.note ? `${v.note} · ${note.text}` : note.text;
      out.push(v);
    }
    for (const [i, p] of (this.file.parked ?? []).entries()) {
      if (sec < p.from || sec > p.until || (routes && !routes.has(p.line)))
        continue;
      const v = this.parkedAt(p, i, sec, serviceDate);
      if (v) out.push(v);
    }
    return out;
  }

  private parkedAt(
    p: ParkedTrain,
    i: number,
    sec: number,
    serviceDate: string,
  ): VehicleState | undefined {
    const track = this.g.nearest(p.at, 15)[0];
    if (!track) return undefined;
    const k = this.kin(p.line);
    const pos = { seg: track.seg, offset: track.offset };
    const pt = this.g.pointAt(pos, 1);
    const near = Math.abs(sec - p.seen) <= OBSERVED_WINDOW_S;
    const v: VehicleState = {
      id: `${serviceDate}:parked-${i}`,
      routeKey: p.line,
      mode: "skytrain",
      tripId: "",
      headsign: "Not in service · parked",
      lon: pt.lon,
      lat: pt.lat,
      bearing: pt.bearing,
      speed: 0,
      status: "layover",
      provenance: near ? "observed" : "interpolated",
      source: `${p.source} (seen ${formatServiceTime(p.seen)})`,
      serviceDate,
      length: k.length,
      width: k.width,
      observedAt: serviceDayStart(serviceDate) + p.seen * 1000,
      track: pos,
    };
    if (p.consist) v.consist = p.consist;
    if (this.opts.shapes)
      v.shape = [
        ...this.g.walk(pos, -1, k.length / 2).reverse(),
        ...this.g.walk(pos, 1, k.length / 2).slice(1),
      ] as LonLat[];
    return v;
  }

  private runAt(
    r: PreparedRun,
    sec: number,
    serviceDate: string,
  ): VehicleState | undefined {
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
      provenance: "estimated" as const,
      source: `timetable ${this.pp.plan.feedVersion} + run inference`,
      serviceDate,
      length: r.kin.length,
      width: r.kin.width,
    };
    if (e.k === "hold") {
      const pos = { seg: this.file.segIds[e.seg]!, offset: e.offset };
      const v = this.state(
        r,
        base,
        pos,
        e.dir,
        e.kind === "signal" ? "held" : "layover",
        undefined,
        this.nextTripHeadsign(r, lo),
        0,
      );
      if (e.why) v.note = `Held: ${e.why}`;
      return v;
    }
    if (e.k === "move") {
      const path = this.paths[e.path]!;
      const headsign =
        e.kind === "pullin" ? "Not in service · to yard"
        : e.kind === "pullout" ? "Not in service · from yard"
        : "Turning back";
      if (e.via) {
        const { d, speed } = alongVia(e.via, sec);
        const { pos, dir } = this.along(path, d);
        const w = e.waits?.find((x) => sec >= x.t0 && sec <= x.t1);
        const v = this.state(
          r,
          base,
          pos,
          dir,
          w ? "held" : e.kind,
          undefined,
          headsign,
          speed,
        );
        if (w) v.note = `Held: ${w.why}`;
        return v;
      }
      const leg = this.leg(
        e.path,
        e.t1 - e.t0,
        e.kind === "turnback" ? r.turnbackKin : r.deadheadKin,
      );
      const tt = Math.min(e.t1 - e.t0, Math.max(0, sec - e.t0));
      const d = distanceAt(leg, tt);
      const { pos, dir } = this.along(path, d);
      const status: VehicleStatus = e.kind;
      return this.state(
        r,
        base,
        pos,
        dir,
        status,
        undefined,
        headsign,
        speedAt(leg, tt),
      );
    }
    // Revenue trip.
    const t = this.pp.tripIndex.get(e.trip)!;
    const pat = this.file.patterns[e.pattern]!;
    const n = t.arr.length;
    const arr = te.arr!;
    const dep = te.dep!;
    const hopPath = (i: number) =>
      i === 0 && e.berth ? e.berth.hop
      : i === n - 2 && e.arrive ? e.arrive.hop
      : pat.hops[i]!;
    const stopPos = (i: number): { pos: TrackPos; dir: Dir } => {
      if (i === 0 && e.berth)
        return {
          pos: { seg: this.file.segIds[e.berth.seg]!, offset: e.berth.offset },
          dir: e.berth.dir,
        };
      if (i === n - 1 && e.arrive)
        return {
          pos: {
            seg: this.file.segIds[e.arrive.seg]!,
            offset: e.arrive.offset,
          },
          dir: e.arrive.dir,
        };
      if (i < n - 1) return this.along(this.paths[hopPath(i)]!, 0);
      const p = this.paths[hopPath(n - 2)]!;
      return this.along(p, p.length);
    };
    let i = 0;
    let hiI = n - 1;
    while (i < hiI) {
      const mid = (i + hiI + 1) >> 1;
      if (arr[mid]! <= sec) i = mid;
      else hiI = mid - 1;
    }
    const headsign = t.trip.headsign;
    // Dispatched trips: seconds late (+) or early (−) against the timetable at this stop or the next.
    const late = (v: VehicleState, at: number) => {
      if (!e.times) return v;
      const d = Math.round(
        at === i && sec <= dep[i]! ?
          dep[i]! - t.dep[i]!
        : arr[at]! - t.arr[at]!,
      );
      if (Math.abs(d) >= 1) v.delay = d;
      return v;
    };
    if (sec <= dep[i]! || i === n - 1) {
      const { pos, dir } = stopPos(i);
      return late(
        this.state(
          r,
          base,
          pos,
          dir,
          "dwell",
          this.pp.plan.stops[t.pattern.stops[i]!]!.name,
          headsign,
          0,
          t.trip.id,
          t.route.key,
        ),
        i,
      );
    }
    const pi = hopPath(i);
    const path = this.paths[pi]!;
    const waits = e.waits?.filter((w) => w.hop === i);
    const via = e.via?.find((x) => x.hop === i);
    if (via) {
      const { d, speed } = alongVia(via.pts, sec);
      const { pos, dir } = this.along(path, d);
      const w = waits?.find((x) => sec >= x.t0 && sec <= x.t1);
      const next = this.pp.plan.stops[t.pattern.stops[i + 1]!]!.name;
      const v = this.state(
        r,
        base,
        pos,
        dir,
        w ? "held" : "moving",
        next,
        headsign,
        speed,
        t.trip.id,
        t.route.key,
      );
      if (w) v.note = `Held: ${w.why}`;
      return late(v, i + 1);
    }
    if (waits?.length)
      return late(
        this.hopWithWaits(
          r,
          base,
          path,
          dep[i]!,
          arr[i + 1]!,
          waits,
          sec,
          this.pp.plan.stops[t.pattern.stops[i + 1]!]!.name,
          headsign,
          t.trip.id,
          t.route.key,
        ),
        i + 1,
      );
    const leg = this.leg(pi, arr[i + 1]! - dep[i]!, r.kin);
    const tt = sec - dep[i]!;
    const d = distanceAt(leg, tt);
    const { pos, dir } = this.along(path, d);
    const holding = tt < leg.hold;
    return late(
      this.state(
        r,
        base,
        pos,
        dir,
        holding ? "dwell" : "moving",
        this.pp.plan.stops[t.pattern.stops[holding ? i : i + 1]!]!.name,
        headsign,
        speedAt(leg, tt),
        t.trip.id,
        t.route.key,
      ),
      holding ? i : i + 1,
    );
  }

  /** A hop with signal waits: stop-to-stop legs between the waits, standing still during them. */
  private hopWithWaits(
    r: PreparedRun,
    base: Pick<
      VehicleState,
      "id" | "provenance" | "source" | "serviceDate" | "length" | "width"
    >,
    path: DecodedPath,
    dep: number,
    arr: number,
    waits: HopWait[],
    sec: number,
    nextStop: string,
    headsign: string,
    tripId: string,
    routeKey: string,
  ): VehicleState {
    let d0 = 0;
    let t0 = dep;
    for (const w of [
      ...waits,
      { d: path.length, t0: arr, t1: arr, why: "" } as HopWait,
    ]) {
      if (sec < w.t0) {
        const leg = this.freeLeg(w.d - d0, w.t0 - t0, r.kin);
        const { pos, dir } = this.along(path, d0 + distanceAt(leg, sec - t0));
        return this.state(
          r,
          base,
          pos,
          dir,
          "moving",
          nextStop,
          headsign,
          speedAt(leg, sec - t0),
          tripId,
          routeKey,
        );
      }
      if (sec <= w.t1 && w.why) {
        const { pos, dir } = this.along(path, w.d);
        const v = this.state(
          r,
          base,
          pos,
          dir,
          "held",
          nextStop,
          headsign,
          0,
          tripId,
          routeKey,
        );
        v.note = `Held: ${w.why}`;
        return v;
      }
      d0 = w.d;
      t0 = w.t1;
    }
    const { pos, dir } = this.along(path, path.length);
    return this.state(
      r,
      base,
      pos,
      dir,
      "moving",
      nextStop,
      headsign,
      0,
      tripId,
      routeKey,
    );
  }

  private freeLeg(
    distance: number,
    duration: number,
    k: Kinematics,
  ): LegProfile {
    const key = `d${distance.toFixed(2)}|${duration}|${k.maxSpeed}`;
    let l = this.legCache.get(key);
    if (!l) this.legCache.set(key, (l = solveLeg(distance, duration, k)));
    return l;
  }

  private nextTripHeadsign(r: PreparedRun, from: number): string {
    for (let j = from + 1; j < r.events.length; j++) {
      const e = r.events[j]!.e;
      if (e.k === "trip")
        return this.pp.tripIndex.get(e.trip)?.trip.headsign ?? "";
    }
    return "Not in service";
  }

  private leg(path: number, duration: number, k: Kinematics): LegProfile {
    const key = `${path}|${duration}|${k.maxSpeed}`;
    let l = this.legCache.get(key);
    if (!l)
      this.legCache.set(
        key,
        (l = solveLeg(this.paths[path]!.length, duration, k)),
      );
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
    base: Pick<
      VehicleState,
      "id" | "provenance" | "source" | "serviceDate" | "length" | "width"
    >,
    pos: TrackPos,
    dir: Dir,
    status: VehicleStatus,
    stopName: string | undefined,
    headsign: string,
    speed: number,
    tripId = "",
    routeKey = r.run.line,
  ): VehicleState {
    const p = this.g.pointAt(pos, dir);
    const v: VehicleState = {
      ...base,
      routeKey,
      mode: "skytrain",
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
      const back = this.g.walk(pos, -dir as Dir, half);
      const fwd = this.g.walk(pos, dir, half);
      v.shape = [...back.reverse(), ...fwd.slice(1)] as LonLat[];
    }
    return v;
  }
}
