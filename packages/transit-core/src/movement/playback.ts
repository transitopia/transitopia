// Play back movement files: train positions on the track graph as a pure function of
// (movements, plan, time) (packages/transit-core/DESIGN.md#movements-and-playback). Revenue trips take their times from the service plan
// (with the same modelled dwell as the schedule engine) and their paths from the routed patterns.

import { timetableLabel } from "../plan/display.ts";
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
import {
  formatServiceTime,
  serviceDayStart,
  type ServiceDate,
} from "../time.ts";

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

/** What every state of a run at one instant shares. */
type Base = Pick<
  VehicleState,
  "id" | "provenance" | "source" | "serviceDate" | "length" | "width"
>;

/** Where a run's train is and what it's doing, for TrainPlayback.state(). */
interface TrainAt {
  pos: TrackPos;
  dir: Dir;
  status: VehicleStatus;
  speed: number;
  /** Its trip's headsign, or what it's doing out of service. */
  headsign: string;
  /** The stop it's at or heading for. */
  stopName?: string | undefined;
  /** The trip it's running (none out of service: the run's line is its route). */
  trip?: { id: string; routeKey: string } | undefined;
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
  /** Per parked train (by index): the track it stands on, found once (null: none nearby). */
  private parkedTrack = new Map<number, TrackPos | null>();
  /** VehicleState.source of every estimated train. */
  private source: string;

  readonly file: MovementsFile;
  private pp: PreparedPlan;
  private g: TrackGraph;
  private opts: PlaybackOptions;

  constructor(
    file: MovementsFile,
    pp: PreparedPlan,
    g: TrackGraph,
    kin: KinematicsConfig,
    opts: PlaybackOptions,
  ) {
    this.file = file;
    this.pp = pp;
    this.g = g;
    this.opts = opts;
    this.kin = (line) => kinematicsFor(kin, "skytrain", line);
    this.source = `${timetableLabel(pp.plan)} + run inference`;
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
   * applied (packages/transit-core/DESIGN.md#dispatcher), runs carry their observations: positions within 90 s of a sighting are
   * observed, times moved by observations or disruptions interpolated.
   */
  vehiclesAt(
    sec: number,
    serviceDate: ServiceDate,
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
    serviceDate: ServiceDate,
  ): VehicleState | undefined {
    let pos = this.parkedTrack.get(i);
    if (pos === undefined) {
      const track = this.g.nearest(p.at, 15)[0];
      pos = track ? { seg: track.seg, offset: track.offset } : null;
      this.parkedTrack.set(i, pos);
    }
    if (!pos) return undefined;
    const k = this.kin(p.line);
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
      track: { seg: pos.seg, offset: pos.offset },
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
    serviceDate: ServiceDate,
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
    const base: Base = {
      id: `${serviceDate}:${r.run.id}`,
      provenance: "estimated",
      source: this.source,
      serviceDate,
      length: r.kin.length,
      width: r.kin.width,
    };
    if (e.k === "hold") {
      const v = this.state(r, base, {
        pos: { seg: this.file.segIds[e.seg]!, offset: e.offset },
        dir: e.dir,
        status: e.kind === "signal" ? "held" : "layover",
        speed: 0,
        headsign: this.nextTripHeadsign(r, lo),
      });
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
        const w = e.waits?.find((x) => sec >= x.t0 && sec <= x.t1);
        const v = this.state(r, base, {
          ...this.along(path, d),
          status: w ? "held" : e.kind,
          speed,
          headsign,
        });
        if (w) v.note = `Held: ${w.why}`;
        return v;
      }
      const leg = this.leg(
        e.path,
        e.t1 - e.t0,
        e.kind === "turnback" ? r.turnbackKin : r.deadheadKin,
      );
      const tt = Math.min(e.t1 - e.t0, Math.max(0, sec - e.t0));
      return this.state(r, base, {
        ...this.along(path, distanceAt(leg, tt)),
        status: e.kind,
        speed: speedAt(leg, tt),
        headsign,
      });
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
    const onTrip = {
      headsign: t.trip.headsign,
      trip: { id: t.trip.id, routeKey: t.route.key },
    };
    const stopName = (k: number) =>
      this.pp.plan.stops[t.pattern.stops[k]!]!.name;
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
    if (sec <= dep[i]! || i === n - 1)
      return late(
        this.state(r, base, {
          ...stopPos(i),
          status: "dwell",
          speed: 0,
          stopName: stopName(i),
          ...onTrip,
        }),
        i,
      );
    const pi = hopPath(i);
    const path = this.paths[pi]!;
    const waits = e.waits?.filter((w) => w.hop === i);
    const via = e.via?.find((x) => x.hop === i);
    if (via) {
      const { d, speed } = alongVia(via.pts, sec);
      const w = waits?.find((x) => sec >= x.t0 && sec <= x.t1);
      const v = this.state(r, base, {
        ...this.along(path, d),
        status: w ? "held" : "moving",
        speed,
        stopName: stopName(i + 1),
        ...onTrip,
      });
      if (w) v.note = `Held: ${w.why}`;
      return late(v, i + 1);
    }
    if (waits?.length)
      return late(
        this.hopWithWaits(r, base, sec, {
          path,
          dep: dep[i]!,
          arr: arr[i + 1]!,
          waits,
          stopName: stopName(i + 1),
          ...onTrip,
        }),
        i + 1,
      );
    const leg = this.leg(pi, arr[i + 1]! - dep[i]!, r.kin);
    const tt = sec - dep[i]!;
    const holding = tt < leg.hold;
    return late(
      this.state(r, base, {
        ...this.along(path, distanceAt(leg, tt)),
        status: holding ? "dwell" : "moving",
        speed: speedAt(leg, tt),
        stopName: stopName(holding ? i : i + 1),
        ...onTrip,
      }),
      holding ? i : i + 1,
    );
  }

  /** A hop with signal waits: stop-to-stop legs between the waits, standing still during them. */
  private hopWithWaits(
    r: PreparedRun,
    base: Base,
    sec: number,
    hop: {
      path: DecodedPath;
      /** Departure from the hop's first stop and arrival at its last (service-day s). */
      dep: number;
      arr: number;
      waits: HopWait[];
      /** The stop it's heading for, and the trip it's running. */
      stopName: string;
      headsign: string;
      trip: { id: string; routeKey: string };
    },
  ): VehicleState {
    const { path, dep, arr, waits } = hop;
    const shown = {
      stopName: hop.stopName,
      headsign: hop.headsign,
      trip: hop.trip,
    };
    let d0 = 0;
    let t0 = dep;
    for (const w of [
      ...waits,
      { d: path.length, t0: arr, t1: arr, why: "" } as HopWait,
    ]) {
      if (sec < w.t0) {
        const leg = this.freeLeg(w.d - d0, w.t0 - t0, r.kin);
        return this.state(r, base, {
          ...this.along(path, d0 + distanceAt(leg, sec - t0)),
          status: "moving",
          speed: speedAt(leg, sec - t0),
          ...shown,
        });
      }
      if (sec <= w.t1 && w.why) {
        const v = this.state(r, base, {
          ...this.along(path, w.d),
          status: "held",
          speed: 0,
          ...shown,
        });
        v.note = `Held: ${w.why}`;
        return v;
      }
      d0 = w.d;
      t0 = w.t1;
    }
    return this.state(r, base, {
      ...this.along(path, path.length),
      status: "moving",
      speed: 0,
      ...shown,
    });
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

  private state(r: PreparedRun, base: Base, at: TrainAt): VehicleState {
    const { pos, dir, status, speed, headsign, stopName } = at;
    const p = this.g.pointAt(pos, dir);
    const v: VehicleState = {
      ...base,
      routeKey: at.trip?.routeKey ?? r.run.line,
      mode: "skytrain",
      tripId: at.trip?.id ?? "",
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
