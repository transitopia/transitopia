// The dispatcher's view of a train run (PLAN.md §4.11): the run's movement events turned into a
// sequence of waits (stops, layovers) and one-direction moves along a single "route coordinate" G,
// the distance the train has travelled along its own path since the run started. Everything the
// simulation tracks per train (position, reservations, released junctions) is a range of G.

import type { Dir, TrackPos } from "../infra/graph.ts";
import type { PreparedPlan } from "../schedule/engine.ts";
import {
  kinematicsFor,
  type Kinematics,
  type KinematicsConfig,
} from "../movement/kinematics.ts";
import type { MovementsFile, Run } from "../movement/types.ts";

export interface RoutePiece {
  seg: string;
  from: number;
  to: number;
  dir: Dir;
  /** Route coordinates of the piece's start and end. */
  g0: number;
  g1: number;
  /** The train reverses just before this piece. */
  rev: boolean;
}

export interface WaitItem {
  k: "wait";
  /** Index of the run event this came from. */
  ev: number;
  /** Stop index within the trip (trip events only). */
  stop?: number;
  /** Planned start and end (service-day seconds). */
  t0: number;
  until: number;
  /** Shortest acceptable duration when the train arrives late. */
  minDur: number;
  g: number;
  pos: TrackPos;
  dir: Dir;
}

export interface MoveItem {
  k: "move";
  ev: number;
  /** Hop index within the trip (trip events only). */
  hop?: number;
  /** Planned departure (never earlier) and arrival. */
  notBefore: number;
  plannedEnd: number;
  g0: number;
  g1: number;
  revenue: boolean;
  /** Empty-move kind (sets its speed); undefined for revenue hops. */
  kind?: "pullout" | "pullin" | "turnback";
}

export type Item = WaitItem | MoveItem;

export interface TrainModel {
  run: Run;
  line: string;
  length: number;
  kin: Kinematics;
  items: Item[];
  route: RoutePiece[];
}

/** Decode a packed path into pieces with the movement file's segment ids. */
export function decodePath(
  file: MovementsFile,
  index: number,
): { seg: string; from: number; to: number }[] {
  const packed = file.paths[index]!;
  const out: { seg: string; from: number; to: number }[] = [];
  for (let i = 0; i < packed.length; i += 3)
    out.push({
      seg: file.segIds[packed[i]!]!,
      from: packed[i + 1]!,
      to: packed[i + 2]!,
    });
  return out;
}

export interface ModelOptions {
  minHoldS: number;
}

/** Build the dispatcher's model of every run in a movement file. */
export function buildModels(
  file: MovementsFile,
  pp: PreparedPlan,
  kinCfg: KinematicsConfig,
  opts: ModelOptions,
): TrainModel[] {
  return file.runs.map((run) => buildModel(file, pp, kinCfg, opts, run));
}

function buildModel(
  file: MovementsFile,
  pp: PreparedPlan,
  kinCfg: KinematicsConfig,
  opts: ModelOptions,
  run: Run,
): TrainModel {
  const kin = kinematicsFor(kinCfg, "skytrain", run.line);
  const items: Item[] = [];
  const route: RoutePiece[] = [];
  let G = 0;
  let lastDir: Dir | undefined;
  let lastSeg: string | undefined;
  let lastPos: TrackPos | undefined;

  const addMove = (
    pieces: { seg: string; from: number; to: number }[],
    base: Omit<MoveItem, "k" | "g0" | "g1">,
  ) => {
    const real = pieces.filter((p) => Math.abs(p.to - p.from) > 1e-6);
    if (!real.length) return;
    const g0 = G;
    real.forEach((p, i) => {
      const dir: Dir = p.to >= p.from ? 1 : -1;
      const len = Math.abs(p.to - p.from);
      // A reversal: the same segment traversed the other way straight after (turnbacks, stub berths).
      const rev =
        i === 0
        && lastSeg === p.seg
        && lastDir !== undefined
        && lastDir !== dir;
      route.push({
        seg: p.seg,
        from: p.from,
        to: p.to,
        dir,
        g0: G,
        g1: G + len,
        rev,
      });
      G += len;
      lastSeg = p.seg;
      lastDir = dir;
    });
    const end = real[real.length - 1]!;
    lastPos = { seg: end.seg, offset: end.to };
    items.push({ k: "move", ...base, g0, g1: G });
  };
  const addWait = (w: Omit<WaitItem, "k" | "g">) => {
    // Only moves set the direction of travel: a layover hold faces the next departure, which would
    // hide a reversal in place.
    items.push({ k: "wait", ...w, g: G });
    if (!lastPos) {
      lastPos = w.pos;
      lastSeg = w.pos.seg;
      lastDir = w.dir;
    }
  };

  run.events.forEach((e, ev) => {
    if (e.k === "hold") {
      addWait({
        ev,
        t0: e.t0,
        until: e.t1,
        minDur: Math.min(e.t1 - e.t0, opts.minHoldS),
        pos: { seg: file.segIds[e.seg]!, offset: e.offset },
        dir: e.dir,
      });
    } else if (e.k === "move") {
      addMove(decodePath(file, e.path), {
        ev,
        notBefore: e.t0,
        plannedEnd: e.t1,
        revenue: false,
        kind: e.kind,
      });
    } else {
      const t = pp.tripIndex.get(e.trip);
      if (!t)
        throw new Error(`Run ${run.id} references unknown trip ${e.trip}`);
      const pat = file.patterns[e.pattern]!;
      const n = t.arr.length;
      const hopPath = (i: number) =>
        i === 0 && e.berth ? e.berth.hop
        : i === n - 2 && e.arrive ? e.arrive.hop
        : pat.hops[i]!;
      const first = decodePath(file, hopPath(0))[0]!;
      const startPos = { seg: first.seg, offset: first.from };
      const startDir: Dir = first.to >= first.from ? 1 : -1;
      addWait({
        ev,
        stop: 0,
        t0: Math.min(t.arr[0]!, t.dep[0]!),
        until: t.dep[0]!,
        minDur: 0,
        pos: startPos,
        dir: startDir,
      });
      for (let i = 0; i + 1 < n; i++) {
        addMove(decodePath(file, hopPath(i)), {
          ev,
          hop: i,
          notBefore: t.dep[i]!,
          plannedEnd: t.arr[i + 1]!,
          revenue: true,
        });
        const last = i + 1 === n - 1;
        const dwell = t.dep[i + 1]! - t.arr[i + 1]!;
        addWait({
          ev,
          stop: i + 1,
          t0: t.arr[i + 1]!,
          until: last ? t.arr[i + 1]! : t.dep[i + 1]!,
          minDur: last ? 0 : Math.min(dwell, kin.dwell),
          pos: lastPos!,
          dir: lastDir!,
        });
      }
    }
  });
  return {
    run,
    line: run.line,
    length: kin.length,
    kin: { ...kin },
    items,
    route,
  };
}

/** Kinematics for empty moves, matching playback (PLAN.md §4.4). */
export function deadheadKinematics(
  k: Kinematics,
  speedFactor: number,
): Kinematics {
  return { ...k, maxSpeed: k.maxSpeed * speedFactor, minCruiseFraction: 0.5 };
}

/** A stop time the dispatcher must honour (see corrections/reconcile.ts railInputs). */
export interface AnchorInput {
  run: string;
  trip: string;
  stop: number;
  t: number;
  event: "arrive" | "depart" | "at";
}

/**
 * Move anchored stops to their observed times. An arrival keeps the hop's planned running time
 * (the difference is spent at the previous stop); a departure ends the dwell there. Anchors
 * override "never early". Later trips are left to the simulation (delays carry and are absorbed).
 */
export function applyAnchors(
  models: TrainModel[],
  anchors: AnchorInput[],
  pp: PreparedPlan,
): void {
  const byRun = new Map(models.map((m) => [m.run.id, m]));
  for (const a of anchors) {
    const m = byRun.get(a.run);
    if (!m) continue;
    const ev = m.run.events.findIndex(
      (e) => e.k === "trip" && e.trip === a.trip,
    );
    if (ev < 0) continue;
    const t = pp.tripIndex.get(a.trip)!;
    const n = t.arr.length;
    const wait = (stop: number) =>
      m.items.find(
        (it): it is WaitItem =>
          it.k === "wait" && it.ev === ev && it.stop === stop,
      );
    const move = (hop: number) =>
      m.items.find(
        (it): it is MoveItem =>
          it.k === "move" && it.ev === ev && it.hop === hop,
      );
    const dwell = t.dep[a.stop]! - t.arr[a.stop]!;
    const arrive =
      a.event === "arrive" ? a.t
      : a.event === "at" ? a.t - dwell / 2
      : undefined;
    const depart =
      a.event === "depart" ? a.t
      : a.event === "at" && a.stop < n - 1 ? a.t + dwell / 2
      : undefined;
    if (arrive !== undefined && a.stop > 0) {
      const mv = move(a.stop - 1);
      if (mv) {
        const run = mv.plannedEnd - mv.notBefore;
        mv.plannedEnd = arrive;
        mv.notBefore = arrive - run;
        const w = wait(a.stop - 1);
        if (w && w.until > mv.notBefore) w.until = mv.notBefore;
      }
      const w = wait(a.stop);
      if (w) {
        w.t0 = arrive;
        if (a.stop === n - 1) w.until = arrive;
      }
    }
    if (depart !== undefined) {
      const w = wait(a.stop);
      if (w) {
        w.until = depart;
        w.minDur = Math.min(w.minDur, Math.max(0, depart - (arrive ?? w.t0)));
      }
      const mv = move(a.stop);
      if (mv) {
        const run = mv.plannedEnd - mv.notBefore;
        mv.notBefore = depart;
        mv.plannedEnd = depart + run;
      }
    }
  }
}
