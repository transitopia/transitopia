// Build movement files: infer physical train runs from the timetable and lay them onto the track
// graph (docs/skytrain-viz-PLAN.md §4.3–4.4). This is the "best guess" layer; every assumption comes from
// regions/metro-vancouver/config/operations.json and kinematics.json so it can be corrected.
//
// Steps: route each stop pattern over the tracks → chain trips into runs at termini (FIFO: each
// arrival takes the earliest feasible departure, preferring its GTFS block) → add yard pull-outs and
// pull-ins → emit events, splitting deadheads at reversals so playback only handles one-direction moves.

import type {
  Dir,
  Path,
  PathPiece,
  TrackGraph,
  TrackPos,
} from "../infra/graph.ts";
import { REVENUE_KIND_PENALTY, routePattern } from "../infra/patterns.ts";
import type { PlatformAssignment } from "../infra/platforms.ts";
import type { PreparedPlan, PreparedTrip } from "../schedule/engine.ts";
import {
  kinematicsFor,
  minLegTime,
  type KinematicsConfig,
} from "./kinematics.ts";
import type {
  Berth,
  MovementsFile,
  MoveKind,
  PackedPath,
  Run,
  RunEvent,
} from "./types.ts";
import type { LineKey, SegmentKind } from "../infra/types.ts";
import type { PlanStop } from "../plan/types.ts";
import { distM } from "../geo.ts";

export interface OperationsConfig {
  fleets: { groups: string[][] };
  turnback: {
    minLayoverS: number;
    maxLayoverS: number;
    maxTurnbackM: number;
    stubMaxLayoverS: number;
    maxPullUpM: number;
    speedFactor: number;
    unloadS: number;
    reversalS: number;
    blockBonusS: number;
  };
  yard: {
    maxDeadheadM: number;
    pullOutLeadS: number;
    deadheadSpeedFactor: number;
    runIntoYardM: number;
    againstTrafficPenalty: number;
  };
}

interface TripInfo {
  t: PreparedTrip;
  line: string;
  fleet: number;
  station0: string;
  station1: string;
  pos0: TrackPos;
  pos1: TrackPos;
  dir0: Dir;
  dir1: Dir;
  dep: number;
  arr: number;
  block?: string;
}

const YARD = new Set<SegmentKind>(["yard"]);
/** Turnback choice: route-metre cost of a reversal, and of departing from a non-GTFS platform. */
const REVERSAL_COST_M = 200;
const OFF_PLATFORM_COST_M = 500;
/** Shortest layover accepted when following a GTFS block (s). */
const BLOCK_MIN_LAYOVER_S = 30;
/** A berth counts as occupied this long before arrival and after departure (s). */
const BERTH_MARGIN_S = 20;
const PLATFORM_KINDS = new Set<SegmentKind>([
  "main",
  "pocket",
  "tail",
  "siding",
]);

export function pieceDir(p: PathPiece): Dir {
  return p.to >= p.from ? 1 : -1;
}

/** Split a path into one-direction sub-paths at each reversal. */
export function splitAtReversals(pieces: PathPiece[]): PathPiece[][] {
  const out: PathPiece[][] = [];
  let cur: PathPiece[] = [];
  for (const p of pieces) {
    const prev = cur[cur.length - 1];
    if (
      prev
      && prev.seg === p.seg
      && pieceDir(prev) !== pieceDir(p)
      && Math.abs(prev.to - p.from) < 1e-6
    ) {
      out.push(cur);
      cur = [];
    }
    if (Math.abs(p.to - p.from) > 1e-6) cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function reversePath(p: Path): Path {
  return {
    pieces: [...p.pieces]
      .reverse()
      .map((x) => ({ seg: x.seg, from: x.to, to: x.from })),
    length: p.length,
    reversals: p.reversals,
    startDir: -p.endDir as Dir,
    endDir: -p.startDir as Dir,
  };
}

const lengthOf = (pieces: PathPiece[]) =>
  pieces.reduce((s, p) => s + Math.abs(p.to - p.from), 0);

/** Track out of service for part of a day (a disruption): trips of `patterns` route around it. */
export interface Closure {
  segs: Set<string>;
  /** Service-day seconds. */
  from: number;
  to: number;
  patterns: Set<number>;
}

export interface BuildInput {
  graph: TrackGraph;
  closures?: Closure[];
  pp: PreparedPlan;
  platforms: Map<string, PlatformAssignment>;
  /** Per-pattern platform positions from role-based rules. */
  patternPositions?: Map<number, Map<number, TrackPos>>;
  services: Set<string>;
  ops: OperationsConfig;
  kin: KinematicsConfig;
}

export function buildMovements({
  graph: g,
  pp,
  platforms,
  patternPositions,
  services,
  ops,
  kin,
  closures = [],
}: BuildInput): MovementsFile {
  /** Track closed at service time t (disruptions), and a cache-key tag for it. */
  const closedAt = (t: number): { closed?: Set<string>; tag: string } => {
    const i = closures.findIndex((c) => t >= c.from && t <= c.to);
    return i < 0 ? { tag: "" } : { closed: closures[i]!.segs, tag: `c${i}|` };
  };
  const plan = pp.plan;
  const railRoutes = new Set(
    plan.routes.filter((r) => r.kind === "skytrain").map((r) => r.key),
  );
  const fleetOf = new Map<string, number>();
  ops.fleets.groups.forEach((grp, i) => grp.forEach((l) => fleetOf.set(l, i)));

  // --- path table ---
  const segIds: string[] = [];
  const segIndex = new Map<string, number>();
  const segIdx = (id: string) => {
    let i = segIndex.get(id);
    if (i === undefined) {
      i = segIds.length;
      segIds.push(id);
      segIndex.set(id, i);
    }
    return i;
  };
  const paths: PackedPath[] = [];
  const pathIndex = new Map<string, number>();
  const addPath = (pieces: PathPiece[]): number => {
    const packed: PackedPath = [];
    for (const p of pieces)
      packed.push(
        segIdx(p.seg),
        Math.round(p.from * 100) / 100,
        Math.round(p.to * 100) / 100,
      );
    const key = packed.join(",");
    let i = pathIndex.get(key);
    if (i === undefined) {
      i = paths.length;
      paths.push(packed);
      pathIndex.set(key, i);
    }
    return i;
  };

  // --- patterns ---
  const patternRoutes = new Map<number, ReturnType<typeof routePattern>>();
  const patternsOut: MovementsFile["patterns"] = {};
  for (const p of plan.patterns) {
    if (!railRoutes.has(p.route)) continue;
    const closure = closures.find((c) => c.patterns.has(p.id));
    const r = routePattern(
      g,
      plan,
      platforms,
      p,
      patternPositions,
      closure?.segs,
    );
    if (r.failures.length) continue;
    patternRoutes.set(p.id, r);
    patternsOut[p.id] = { hops: r.hops.map((h) => addPath(h!.pieces)) };
  }

  // Normal direction of traffic per segment: the directions revenue trips use it in (bit 1: +, 2: −).
  const revenueDirs = new Map<string, number>();
  for (const r of patternRoutes.values()) {
    for (const h of r.hops)
      for (const p of h!.pieces)
        if (p.to !== p.from)
          revenueDirs.set(
            p.seg,
            (revenueDirs.get(p.seg) ?? 0) | (p.to > p.from ? 1 : 2),
          );
  }
  const againstTraffic = (seg: string, dir: Dir) => {
    const d = revenueDirs.get(seg);
    return d === (dir === 1 ? 2 : 1) ? ops.yard.againstTrafficPenalty : 0;
  };

  // --- trips ---
  const stationOf = (si: number) =>
    plan.stops[si]!.parent ?? plan.stops[si]!.name.replace(/\s*@.*$/, "");
  const trips: TripInfo[] = [];
  let unplaced = 0;
  for (const service of services) {
    for (const t of pp.tripsByService.get(service) ?? []) {
      if (!railRoutes.has(t.route.key)) continue;
      const r = patternRoutes.get(t.pattern.id);
      if (!r || r.startDir === undefined || r.endDir === undefined) {
        unplaced++;
        continue;
      }
      const n = t.pattern.stops.length;
      const info: TripInfo = {
        t,
        line: t.route.key,
        fleet: fleetOf.get(t.route.key) ?? -1,
        station0: stationOf(t.pattern.stops[0]!),
        station1: stationOf(t.pattern.stops[n - 1]!),
        pos0: r.positions[0]!,
        pos1: r.positions[n - 1]!,
        dir0: r.startDir,
        dir1: r.endDir,
        dep: t.dep[0]!,
        arr: t.arr[n - 1]!,
      };
      if (t.trip.block) info.block = t.trip.block;
      trips.push(info);
    }
  }

  // --- turnback / yard routing (cached) ---
  const pk = (p: TrackPos) => `${p.seg}@${p.offset.toFixed(1)}`;
  const tbCache = new Map<string, Path | null>();
  const turnback = (a: TripInfo, d: TripInfo): Path | null => {
    const { closed, tag } = closedAt(a.arr);
    const key = `${tag}${pk(a.pos1)}|${a.dir1}|${pk(d.pos0)}|${d.dir0}`;
    let r = tbCache.get(key);
    if (r !== undefined) return r;
    r = g.route(a.pos1, d.pos0, {
      ...(closed ? { closed } : {}),
      fromDir: a.dir1,
      toDir: d.dir0,
      allowReversals: true,
      allowMainReversals: true,
      allowReverseAtStart: true,
      allowReverseAtTarget: true,
      maxLength: ops.turnback.maxTurnbackM,
    });
    tbCache.set(key, r);
    return r;
  };
  const yardCache = new Map<string, Path | null>();
  /**
   * Path from a platform to the nearest yard (for pull-ins), extended into the yard. `reversed`: the
   * path will be run backwards (a pull-out), so traffic direction is judged the other way round.
   */
  const toYard = (
    pos: TrackPos,
    dir: Dir,
    reversed = false,
    at = -1,
  ): Path | null => {
    const { closed, tag } = closedAt(at);
    const key = `${tag}${pk(pos)}|${dir}|${reversed}`;
    let r = yardCache.get(key);
    if (r !== undefined) return r;
    r = g.route(pos, null, {
      ...(closed ? { closed } : {}),
      fromDir: dir,
      allowReversals: true,
      allowReverseAtStart: true,
      goalKinds: YARD,
      maxLength: ops.yard.maxDeadheadM * (1 + ops.yard.againstTrafficPenalty),
      dirPenalty:
        reversed ? (seg, d) => againstTraffic(seg, -d as Dir) : againstTraffic,
    });
    if (r) {
      const last = r.pieces[r.pieces.length - 1]!;
      const ys = g.segment(last.seg);
      const d = pieceDir(last);
      const into = Math.min(ys.length, ops.yard.runIntoYardM);
      r.pieces.push({
        seg: last.seg,
        from: last.to,
        to:
          d === 1 ?
            Math.min(ys.length, last.to + into)
          : Math.max(0, last.to - into),
      });
      r.length += into;
    }
    yardCache.set(key, r);
    return r;
  };

  // Empty moves: turnbacks at their own speed, pull-outs and pull-ins slower (config).
  const speedFactorFor = (kind: MoveKind) =>
    kind === "turnback" ?
      ops.turnback.speedFactor
    : ops.yard.deadheadSpeedFactor;
  // Minimum time for a (possibly reversing) deadhead path.
  const deadheadTime = (
    line: string,
    path: Path,
    kind: MoveKind = "turnback",
  ) => {
    const k = kinematicsFor(kin, "skytrain", line);
    const subs = splitAtReversals(path.pieces);
    const moving = subs.reduce(
      (s, sub) => s + minLegTime(lengthOf(sub), k, speedFactorFor(kind)),
      0,
    );
    return moving + Math.max(0, subs.length - 1) * ops.turnback.reversalS;
  };

  // Departing from the arrival berth instead (reverse in place): the first hop from there.
  const berthCache = new Map<string, Path | null>();
  const fromArrivalBerth = (a: TripInfo, d: TripInfo): Path | null => {
    const r = patternRoutes.get(d.t.pattern.id)!;
    const second = r.positions[1]!;
    const dir = -a.dir1 as Dir;
    const { closed, tag } = closedAt(a.arr);
    const key = `${tag}${pk(a.pos1)}|${dir}|${pk(second)}`;
    let p = berthCache.get(key);
    if (p !== undefined) return p;
    p = g.route(a.pos1, second, {
      fromDir: dir,
      allowReversals: false,
      maxLength: 12_000,
      kindPenalty: REVENUE_KIND_PENALTY,
      ...(closed ? { closed } : {}),
    });
    if (p && p.reversals > 0) p = null;
    berthCache.set(key, p);
    return p;
  };

  /** On a dead-ended segment, pull the berth up to the buffer so the train clears the switch behind it. */
  const pullUp = (pos: TrackPos, len: number): TrackPos => {
    const s = g.segment(pos.seg);
    const margin = 10;
    if (g.isDeadEnd(pos.seg, -1))
      return {
        seg: pos.seg,
        offset: Math.min(s.length - len / 2, len / 2 + margin),
      };
    if (g.isDeadEnd(pos.seg, 1))
      return {
        seg: pos.seg,
        offset: Math.max(len / 2, s.length - len / 2 - margin),
      };
    return pos;
  };
  /** This line's dead-ended running tracks within 150 m of a stop (cached per stop and line). */
  const stubCache = new Map<string, string[]>();
  const stubsNear = (stop: PlanStop, line: string) => {
    const key = `${stop.id}|${line}`;
    let list = stubCache.get(key);
    if (!list) {
      list = [...g.segments.values()]
        .filter(
          (sg) =>
            PLATFORM_KINDS.has(sg.kind)
            && sg.lines.includes(line as LineKey)
            && (g.isDeadEnd(sg.id, 1) || g.isDeadEnd(sg.id, -1))
            && sg.coords.some((c) => distM(c, [stop.lon, stop.lat]) < 150),
        )
        .map((sg) => sg.id);
      stubCache.set(key, list);
    }
    return list;
  };
  /** Stub terminus: the line has dead-ended platform tracks here, so waiting trains block a berth. */
  const atStubTerminus = (a: TripInfo) =>
    stubsNear(
      plan.stops[a.t.pattern.stops[a.t.pattern.stops.length - 1]!]!,
      a.line,
    ).length > 0;
  /**
   * Surplus trains at stub termini go back to the yard rather than queue for a far-off departure
   * (operators run them empty between scheduled trains; OPEN-QUESTIONS #21).
   */
  const tooLongAtStub = (a: TripInfo, link: Link) =>
    link.d.dep - a.arr > ops.turnback.stubMaxLayoverS && atStubTerminus(a);
  /**
   * A stub terminus holds at most one waiting train per dead-ended track (e.g. Waterfront Expo: the
   * turnback stub and Platform 2). A train arriving when they're all taken is surplus and returns to
   * the yard; otherwise first-come-first-served chaining keeps the morning's pool of trains there
   * all day, with layovers the terminus can't hold (OPEN-QUESTIONS #21).
   */
  const waitingAtStub = new Map<string, [number, number][]>();
  const stubFull = (a: TripInfo) => {
    const cap = stubsNear(
      plan.stops[a.t.pattern.stops[a.t.pattern.stops.length - 1]!]!,
      a.line,
    ).length;
    if (!cap) return false;
    // Counted when this train needs a berth: after unloading and changing ends at the platform.
    const at = a.arr + ops.turnback.unloadS + ops.turnback.reversalS;
    return (
      (waitingAtStub.get(a.station1) ?? []).filter(
        ([from, to]) => from <= at && at < to,
      ).length >= cap
    );
  };

  // --- chaining (FIFO per terminus, preferring the GTFS block) ---
  type Link = { d: TripInfo; path: Path; berthHop?: Path };
  const next = new Map<TripInfo, Link>();
  const hasPrev = new Set<TripInfo>();
  const departuresAt = new Map<string, TripInfo[]>();
  for (const t of trips) {
    const k = `${t.fleet}|${t.station0}`;
    (departuresAt.get(k) ?? departuresAt.set(k, []).get(k)!).push(t);
  }
  for (const list of departuresAt.values()) list.sort((a, b) => a.dep - b.dep);
  // GTFS block successors (same service and block, next by departure).
  const blockNext = new Map<TripInfo, TripInfo>();
  const byBlock = new Map<string, TripInfo[]>();
  for (const t of trips)
    if (t.block)
      (
        byBlock.get(`${t.t.trip.service}|${t.block}`)
        ?? byBlock
          .set(`${t.t.trip.service}|${t.block}`, [])
          .get(`${t.t.trip.service}|${t.block}`)!
      ).push(t);
  for (const list of byBlock.values()) {
    list.sort((x, y) => x.dep - y.dep);
    for (let i = 0; i + 1 < list.length; i++)
      blockNext.set(list[i]!, list[i + 1]!);
  }

  /**
   * Two ways to turn: run to the GTFS departure platform (possibly via tail/pocket reversals), or
   * reverse in place and leave from the arrival berth. Returns the cheaper feasible one. `trusted`
   * (GTFS block successors) skips the time check: the timetable says it's done.
   */
  const tryLink = (
    a: TripInfo,
    d: TripInfo,
    gap: number,
    trusted: boolean,
  ): Link | undefined => {
    let link: Link | undefined;
    let cost = Infinity;
    const path = turnback(a, d);
    if (
      path
      && (trusted || ops.turnback.unloadS + deadheadTime(a.line, path) <= gap)
    ) {
      link = { d, path };
      cost = path.length + REVERSAL_COST_M * path.reversals;
    }
    const berthHop = fromArrivalBerth(a, d);
    if (
      berthHop
      && (trusted || ops.turnback.unloadS + ops.turnback.reversalS <= gap)
      && REVERSAL_COST_M + OFF_PLATFORM_COST_M < cost
    ) {
      link = {
        d,
        path: {
          pieces: [],
          length: 0,
          reversals: 1,
          startDir: berthHop.startDir,
          endDir: berthHop.startDir,
        },
        berthHop,
      };
    }
    return link;
  };

  const arrivals = [...trips].sort((a, b) => a.arr - b.arr);
  const termini: MovementsFile["stats"]["termini"] = {};
  const stationNames = new Map(plan.stations.map((s) => [s.id, s.name]));
  const stationName = (id: string) =>
    stationNames.get(id) ?? pp.stopById.get(id)?.name ?? id;
  for (const a of arrivals) {
    const st = (termini[stationName(a.station1)] ??= {
      chained: 0,
      unchained: 0,
      reasons: {},
    });
    const reason = (r: string) => (st.reasons[r] = (st.reasons[r] ?? 0) + 1);
    const list = departuresAt.get(`${a.fleet}|${a.station1}`);
    if (!list) {
      st.unchained++;
      reason("no departures of this fleet here");
      continue;
    }
    if (stubFull(a)) {
      st.unchained++;
      reason("stub terminus full: returns to yard");
      continue;
    }
    let chosen: Link | undefined;
    let sawCandidate = false;
    let lastReason = "no departure within max layover";
    // 1. The GTFS block's own next trip, if it leaves from here: the timetable planners made that
    //    turn work, so it's trusted even with a short layover.
    const bn = blockNext.get(a);
    if (
      bn
      && !hasPrev.has(bn)
      && bn.station0 === a.station1
      && bn.fleet === a.fleet
    ) {
      const gap = bn.dep - a.arr;
      if (gap >= BLOCK_MIN_LAYOVER_S && gap <= ops.turnback.maxLayoverS)
        chosen = tryLink(a, bn, gap, true);
      if (chosen && tooLongAtStub(a, chosen)) chosen = undefined;
    }
    // 2. Otherwise first come, first served: the earliest feasible departure.
    for (const d of chosen ? [] : list) {
      if (hasPrev.has(d)) continue;
      const gap = d.dep - a.arr;
      if (gap < ops.turnback.minLayoverS) continue;
      if (gap > ops.turnback.maxLayoverS) break;
      sawCandidate = true;
      const link = tryLink(a, d, gap, false);
      if (!link) {
        lastReason =
          turnback(a, d) ? "turnback too slow" : (
            "no turnback path or berth route"
          );
        continue;
      }
      if (tooLongAtStub(a, link)) {
        lastReason = "surplus at stub terminus: returns to yard";
        break;
      }
      chosen = link;
      break;
    }
    if (chosen) {
      next.set(a, chosen);
      hasPrev.add(chosen.d);
      st.chained++;
      if (atStubTerminus(a))
        (
          waitingAtStub.get(a.station1)
          ?? waitingAtStub.set(a.station1, []).get(a.station1)!
        ).push([a.arr, chosen.d.dep]);
    } else {
      st.unchained++;
      reason(sawCandidate ? lastReason : "no departure within max layover");
    }
  }

  // --- runs and events ---
  const runs: Run[] = [];
  const pathOf = (pieces: PathPiece[]) => addPath(pieces);
  /** Emit a deadhead ending no later than tEnd (or starting at tStart), split at reversals. */
  const emitDeadhead = (
    events: RunEvent[],
    line: string,
    path: Path,
    kind: MoveKind,
    window: { start: number; end: number },
    anchor: "start" | "end",
  ) => {
    const k = kinematicsFor(kin, "skytrain", line);
    const subs = splitAtReversals(path.pieces);
    const times = subs.map((s) =>
      minLegTime(lengthOf(s), k, speedFactorFor(kind)),
    );
    const revs = Math.max(0, subs.length - 1) * ops.turnback.reversalS;
    const need = times.reduce((a, b) => a + b, 0) + revs;
    const avail = window.end - window.start;
    // If the window is too short, the schedule wins: compress proportionally.
    const scale = need > avail && need > 0 ? avail / need : 1;
    // Turnbacks wait out their slack at the first reversal point when that is a tail/pocket/siding,
    // clearing the arrival platform and keeping the departure platform free. (Never on main track,
    // where through trains need to pass.)
    const firstRev =
      subs.length > 1 ?
        g.segment(subs[0]![subs[0]!.length - 1]!.seg)
      : undefined;
    const slackAtReversal =
      kind === "turnback" && firstRev !== undefined && firstRev.kind !== "main";
    const slack = slackAtReversal ? Math.max(0, avail - need) : 0;
    let t = anchor === "start" ? window.start : window.end - need * scale;
    subs.forEach((sub, i) => {
      if (i > 0) {
        const last = subs[i - 1]![subs[i - 1]!.length - 1]!;
        const dt = ops.turnback.reversalS * scale + (i === 1 ? slack : 0);
        events.push({
          k: "hold",
          t0: t,
          t1: t + dt,
          seg: segIdx(last.seg),
          offset: last.to,
          dir: pieceDir(sub[0]!),
          kind: "layover",
        });
        t += dt;
      }
      const dt = times[i]! * scale;
      events.push({ k: "move", t0: t, t1: t + dt, path: pathOf(sub), kind });
      t += dt;
    });
    return t;
  };
  const hold = (
    events: RunEvent[],
    t0: number,
    t1: number,
    pos: TrackPos,
    dir: Dir,
    kind: "layover" | "yard" = "layover",
  ) => {
    if (t1 > t0 + 1e-6)
      events.push({
        k: "hold",
        t0,
        t1,
        seg: segIdx(pos.seg),
        offset: pos.offset,
        dir,
        kind,
      });
  };

  // --- berth allocation for in-place turnbacks ---
  // A train reversing in place occupies its berth from arrival until departure. Give each such visit
  // a berth that is free for its whole stay, choosing among the parallel tracks at the arrival
  // platform (stub termini usually have two), provided the approach and departure both route there
  // without reversing. Visits are processed in arrival order (first come, first served).
  interface Visit {
    pos: TrackPos;
    arriveDir: Dir;
    departDir: Dir;
    arrive?: Berth;
    depart?: Berth;
  }
  const visits = new Map<TripInfo, Visit>();
  const occupied = new Map<
    string,
    { from: number; to: number; offset: number }[]
  >();
  const trainLen = (line: string) =>
    kinematicsFor(kin, "skytrain", line).length;
  const isFree = (pos: TrackPos, from: number, to: number, len: number) =>
    !(occupied.get(pos.seg) ?? []).some(
      (o) =>
        o.from < to && from < o.to && Math.abs(o.offset - pos.offset) < len,
    );
  const noRev = (
    a: TrackPos,
    dir: Dir | undefined,
    b: TrackPos,
    at: number,
  ) => {
    const { closed } = closedAt(at);
    const p = g.route(a, b, {
      fromDir: dir,
      allowReversals: false,
      maxLength: 12_000,
      kindPenalty: REVENUE_KIND_PENALTY,
      ...(closed ? { closed } : {}),
    });
    return p && p.reversals === 0 ? p : null;
  };
  for (const a of arrivals) {
    const link = next.get(a);
    if (!link || (!link.berthHop && link.path.length > 1)) continue;
    const { d } = link;
    const ra = patternRoutes.get(a.t.pattern.id)!;
    const rd = patternRoutes.get(d.t.pattern.id)!;
    const n = ra.positions.length;
    const lastStop = plan.stops[a.t.pattern.stops[n - 1]!]!;
    const from = a.arr - BERTH_MARGIN_S;
    const to = d.dep + BERTH_MARGIN_S;
    const len = trainLen(a.line);
    const defaultDepart = link.berthHop?.startDir ?? d.dir0;
    // Berths: the default position plus this line's dead-ended tracks at the station (stub
    // termini), each pulled up to the buffer so the train clears the switch behind it. A buffer
    // far beyond the platform is closed track, not a berth (Braid), so the train stays at the platform.
    const up = pullUp(a.pos1, len);
    const candidates: TrackPos[] = [
      Math.abs(up.offset - a.pos1.offset) <= ops.turnback.maxPullUpM ?
        up
      : a.pos1,
    ];
    for (const seg of stubsNear(lastStop, a.line)) {
      if (!candidates.some((x) => x.seg === seg))
        candidates.push(pullUp({ seg, offset: 0 }, len));
    }
    let chosen: Visit | undefined;
    for (const pos of candidates) {
      if (!isFree(pos, from, to, len)) continue;
      if (pos.seg === a.pos1.seg && pos.offset === a.pos1.offset) {
        chosen = { pos, arriveDir: a.dir1, departDir: defaultDepart };
        break;
      }
      const inHop = noRev(
        ra.positions[n - 2]!,
        ra.hops[n - 2]!.startDir,
        pos,
        a.arr,
      );
      if (!inHop) continue;
      const outHop = noRev(pos, -inHop.endDir as Dir, rd.positions[1]!, a.arr);
      if (!outHop) continue;
      chosen = {
        pos,
        arriveDir: inHop.endDir,
        departDir: outHop.startDir,
        arrive: {
          seg: segIdx(pos.seg),
          offset: pos.offset,
          dir: inHop.endDir,
          hop: addPath(inHop.pieces),
        },
        depart: {
          seg: segIdx(pos.seg),
          offset: pos.offset,
          dir: outHop.startDir,
          hop: addPath(outHop.pieces),
        },
      };
      break;
    }
    // No free berth: keep the default and let validate:plan report the conflict.
    chosen ??= { pos: a.pos1, arriveDir: a.dir1, departDir: defaultDepart };
    visits.set(a, chosen);
    (
      occupied.get(chosen.pos.seg)
      ?? occupied.set(chosen.pos.seg, []).get(chosen.pos.seg)!
    ).push({ from, to, offset: chosen.pos.offset });
  }

  const starts = trips
    .filter((t) => !hasPrev.has(t))
    .sort((a, b) => a.dep - b.dep);
  let runNo = 0;
  for (const first of starts) {
    const events: RunEvent[] = [];
    const run: Run = {
      id: `${first.line}-${String(++runNo).padStart(3, "0")}`,
      line: first.line,
      events,
    };
    // Pull-out: nearest yard behind the first platform, reversed.
    const back = toYard(first.pos0, -first.dir0 as Dir, true, first.dep);
    const readyAt = first.dep - ops.yard.pullOutLeadS;
    if (back) {
      const out = reversePath(back);
      const t = emitDeadhead(
        events,
        first.line,
        out,
        "pullout",
        { start: readyAt - 3600, end: readyAt },
        "end",
      );
      hold(events, t, first.dep, first.pos0, first.dir0);
      run.fromYard = back.pieces[back.pieces.length - 1]!.seg;
    } else hold(events, readyAt, first.dep, first.pos0, first.dir0);

    let cur: TripInfo | undefined = first;
    let berth: Berth | undefined;
    while (cur) {
      const link = next.get(cur);
      const visit = visits.get(cur);
      events.push({
        k: "trip",
        trip: cur.t.trip.id,
        pattern: cur.t.pattern.id,
        ...(berth ? { berth } : {}),
        ...(visit?.arrive ? { arrive: visit.arrive } : {}),
      });
      berth = undefined;
      if (!link) break;
      const { d, path } = link;
      if (visit) {
        // In-place turnback at the allocated berth.
        if (visit.depart) berth = visit.depart;
        else if (link.berthHop)
          berth = {
            seg: segIdx(visit.pos.seg),
            offset: visit.pos.offset,
            dir: link.berthHop.startDir,
            hop: addPath(link.berthHop.pieces),
          };
        const unloadEnd = Math.min(cur.arr + ops.turnback.unloadS, d.dep);
        hold(events, cur.arr, unloadEnd, visit.pos, visit.arriveDir);
        hold(events, unloadEnd, d.dep, visit.pos, visit.departDir);
        cur = d;
        continue;
      }
      const unloadEnd = Math.min(cur.arr + ops.turnback.unloadS, d.dep);
      hold(events, cur.arr, unloadEnd, cur.pos1, cur.dir1);
      if (path.length > 1) {
        // Clear the arrival platform straight away. With a reversal on the way, the layover is spent
        // there (emitDeadhead); otherwise the train waits at the departure platform.
        const need = deadheadTime(cur.line, path);
        const boardS = 30;
        // Finish before departure (boarding time if there's room); emitDeadhead compresses if short.
        const end = d.dep - boardS >= unloadEnd + need ? d.dep - boardS : d.dep;
        const t = emitDeadhead(
          events,
          cur.line,
          path,
          "turnback",
          { start: unloadEnd, end },
          "start",
        );
        hold(events, t, d.dep, d.pos0, d.dir0);
      } else {
        // Reverse in place (visits without an allocation don't reach here).
        hold(events, unloadEnd, d.dep, d.pos0, d.dir0);
      }
      cur = d;
    }
    // Pull-in after the last trip.
    const last = cur!;
    const inPath = toYard(last.pos1, last.dir1, false, last.arr);
    const unloadEnd = last.arr + ops.turnback.unloadS;
    hold(events, last.arr, unloadEnd, last.pos1, last.dir1);
    if (inPath) {
      emitDeadhead(
        events,
        last.line,
        inPath,
        "pullin",
        { start: unloadEnd, end: unloadEnd + 3600 },
        "start",
      );
      run.toYard = inPath.pieces[inPath.pieces.length - 1]!.seg;
    }
    runs.push(run);
  }

  // --- stats: peak trains in service per line (revenue trips + turnbacks/layovers between them) ---
  const intervals = new Map<string, [number, number][]>();
  for (const run of runs) {
    let t0: number | undefined;
    let t1 = 0;
    for (const e of run.events) {
      if (e.k === "trip") {
        const t = pp.tripIndex.get(e.trip)!;
        t0 ??= t.dep[0]!;
        t1 = t.arr[t.arr.length - 1]!;
      }
    }
    if (t0 !== undefined)
      (
        intervals.get(run.line) ?? intervals.set(run.line, []).get(run.line)!
      ).push([t0, t1]);
  }
  const peakInService: Record<string, number> = {};
  for (const [line, ivs] of intervals) {
    const pts: [number, number][] = [];
    for (const [a, b] of ivs) pts.push([a, 1], [b, -1]);
    pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let c = 0;
    let m = 0;
    for (const [, d] of pts) m = Math.max(m, (c += d));
    peakInService[line] = m;
  }

  return {
    schema: 1,
    feedVersion: plan.feedVersion,
    services: [...services].sort(),
    builtAt: new Date().toISOString(),
    segIds,
    paths,
    patterns: patternsOut,
    runs,
    stats: {
      trips: trips.length,
      runs: runs.length,
      peakInService,
      unplacedTrips: unplaced,
      termini,
    },
  };
}
