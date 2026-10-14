// Signalling simulation for the dispatcher (packages/transit-core/DESIGN.md#dispatcher). All trains of a service day are stepped
// together. A train follows its planned timetable profile exactly while that is safe; otherwise it
// brakes for its movement authority and runs at line speed once released (recovering lost time).
// How far each train may go (moving block, junction locks, section reservations) is the
// interlocking's (interlocking.ts).
//
// A train blocked longer than `maxWaitS` is given authority anyway (reported), so the simulation
// always ends. Deterministic: no randomness, no wall clock; ties break by timetable, then run id.

import type { TrackGraph } from "../infra/graph.ts";
import {
  distanceAt,
  minLegTime,
  solveLeg,
  speedAt,
} from "../movement/kinematics.ts";
import type { MoveItem, TrainModel } from "./model.ts";
import {
  createTrain,
  EPS,
  Interlocking,
  kinOf,
  LOOKAHEAD_SLACK_M,
  offOf,
  stopDist,
  type Train,
} from "./interlocking.ts";

export interface DispatchConfig {
  stepS: number;
  safetyMarginM: number;
  foulingM: number;
  minHoldS: number;
  maxWaitS: number;
  crossingBufferS: number;
  /** Default through-service headway on a single-tracked line (disruptions without a headway). */
  singleTrackHeadwayS: number;
  revenueFirst: boolean;
}

/**
 * Debug output, to the console (CLAUDE.md → Dispatcher notes). The pipelines and the server set it
 * from DISPATCH_DEBUG and DISPATCH_TRACE / _FROM / _TO.
 */
export interface DispatchDebug {
  /** At the first deadlock broken, print the chain of trains waiting for each other. */
  chains?: boolean | undefined;
  /** Trace one run: what blocks it, and its authority requests between two service-day times (s). */
  trace?: { run: string; from: number; to: number } | undefined;
}

export interface SignalWait {
  /** Route coordinate where the train stood. */
  g: number;
  t0: number;
  t1: number;
  why: string;
}

export interface MoveRecord {
  k: "move";
  dep: number;
  arr: number;
  waits: SignalWait[];
  /** [t, distance from the move's start] samples, when the train left its planned profile. */
  via?: [number, number][];
}

export interface WaitRecord {
  k: "wait";
  t0: number;
  t1: number;
}

export interface ForcedGrant {
  run: string;
  t: number;
  seg: string;
  offset: number;
  why: string;
}

export interface SimResult {
  /** Per train (same order as the models), per item. */
  records: (MoveRecord | WaitRecord)[][];
  forced: ForcedGrant[];
}

export interface SpeedFactors {
  deadhead: number;
  turnback: number;
}

/** Simulation steps between yields (async runs let a server keep answering requests meanwhile). */
const YIELD_EVERY_STEPS = 2000;

/** Run the simulation to completion. */
export function simulate(
  models: TrainModel[],
  g: TrackGraph,
  cfg: DispatchConfig,
  speeds: SpeedFactors,
  debug: DispatchDebug = {},
): SimResult {
  const it = simulation(models, g, cfg, speeds, debug);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** The same simulation, yielding to the event loop every few thousand steps (identical result). */
export async function simulateAsync(
  models: TrainModel[],
  g: TrackGraph,
  cfg: DispatchConfig,
  speeds: SpeedFactors,
  debug: DispatchDebug = {},
): Promise<SimResult> {
  const it = simulation(models, g, cfg, speeds, debug);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function* simulation(
  models: TrainModel[],
  g: TrackGraph,
  cfg: DispatchConfig,
  speeds: SpeedFactors,
  debug: DispatchDebug,
): Generator<void, SimResult> {
  const dt = cfg.stepS;
  const margin = cfg.safetyMarginM;
  const il = new Interlocking(models, g, cfg, debug.trace);

  // --- trains ---
  const trains: Train[] = models.map((m, idx) => createTrain(m, idx, speeds));
  const forced: ForcedGrant[] = [];

  const traceRun = debug.trace?.run;
  const traceFrom = debug.trace?.from ?? 0;
  const traceTo = debug.trace?.to ?? 0;
  const noteBlocked = (
    tr: Train,
    t: number,
    why: string,
    item: MoveItem,
    by?: Train,
  ) => {
    if (traceRun === tr.m.run.id && Math.round(t) % 15 === 0)
      console.log(
        `[trace ${Math.round(t)}] ${describe(tr)} :: ${by ? describe(by) : ""}`,
      );
    if (tr.blockedSince === undefined) tr.blockedSince = t;
    tr.blockedWhy = why;
    tr.blockedBy = by;
    if (t - tr.blockedSince > cfg.maxWaitS) {
      if (chains && !forced.length) dumpChain(tr, t);
      const p = tr.m.route[tr.pi]!;
      forced.push({
        run: tr.m.run.id,
        t,
        seg: p.seg,
        offset: offOf(p, Math.min(Math.max(tr.G, p.g0), p.g1)),
        why,
      });
      tr.forcedTo = item.g1;
      tr.blockedSince = undefined;
    }
  };

  const chains = debug.chains ?? false;
  const describe = (tr: Train) => {
    const p = tr.m.route[tr.pi];
    const it = tr.m.items[tr.i];
    const res = tr.res
      .map((r) => `${r.seg}${r.dir > 0 ? "+" : "-"}${r.excl ? "!" : ""}`)
      .join(" ");
    return `${tr.m.run.id} item ${tr.i}/${tr.m.items.length} ${it?.k}${
      it?.k === "move" ?
        it.revenue ?
          " rev"
        : " dh"
      : ""
    } at ${p?.seg}@${p ? offOf(p, Math.min(Math.max(tr.G, p.g0), p.g1)).toFixed(0) : "?"} ${p?.dir} v=${tr.v.toFixed(1)} blocked=${tr.blockedWhy}${tr.blockedBy ? ` by ${tr.blockedBy.m.run.id}` : ""} res=[${res}] locks=[${tr.locks.map((l) => l.node).join(" ")}]`;
  };
  const dumpChain = (tr: Train, t: number) => {
    console.log(`[dispatch] first deadlock at ${t}:`);
    const seen = new Set<Train>();
    for (let x: Train | undefined = tr; x && !seen.has(x); x = x.blockedBy) {
      seen.add(x);
      console.log("  " + describe(x));
    }
  };

  // --- one step for one train ---
  const advance = (tr: Train, t: number, t1: number) => {
    let tau = t;
    il.now = t;
    for (let guard = 0; guard < 50; guard++) {
      const item = tr.m.items[tr.i];
      if (!item) {
        tr.done = true;
        il.release(tr, true);
        return;
      }
      if (item.k === "wait") {
        const end = Math.max(item.until, tr.itemStart + item.minDur);
        if (end > t1) return;
        tr.records.push({ k: "wait", t0: tr.itemStart, t1: end });
        tr.i++;
        tr.itemStart = Number.NaN;
        tau = Math.max(tau, end);
        tr.itemStart = tr.m.items[tr.i]?.k === "wait" ? end : Number.NaN;
        tr.readyAt = end;
        continue;
      }
      const k = kinOf(tr, item);
      const L = item.g1;
      if (Number.isNaN(tr.itemStart)) {
        // Departing.
        const ready = Math.max(item.notBefore, tr.readyAt);
        if (ready > t1) return;
        tau = Math.max(tau, ready);
        const onTime = Math.abs(tau - item.notBefore) < EPS;
        const dist = L - tr.G;
        const duration =
          onTime ?
            item.plannedEnd - item.notBefore
          : Math.max(minLegTime(dist, k), item.plannedEnd - tau);
        const leg = solveLeg(dist, duration, k);
        const tt = Math.min(t1 - tau, leg.duration);
        const gp = tr.G + distanceAt(leg, tt);
        const vp = speedAt(leg, tt);
        const { lim, why, by } = il.authority(
          tr,
          item,
          Math.max(gp - tr.G + stopDist(vp, k), LOOKAHEAD_SLACK_M) + margin,
        );
        if (
          gp + stopDist(vp, k) <= lim + EPS
          || (tt >= leg.duration && lim >= L - EPS)
        ) {
          tr.itemStart = tau;
          tr.prof = { leg, t0: tau, G0: tr.G };
          tr.blockedSince = undefined;
          tr.samples = [[tau, 0]];
          tr.offPlan = false;
        } else if (lim > tr.G + 0.5) {
          tr.itemStart = tau;
          tr.prof = undefined;
          tr.blockedSince = undefined;
          tr.samples = [[tau, 0]];
          tr.offPlan = true;
        } else {
          noteBlocked(tr, t1, why, item, by);
          if (tr.G < tr.forcedTo) continue;
          return;
        }
      }
      // Moving.
      if (tr.prof) {
        const { leg, t0, G0 } = tr.prof;
        const arrive = t0 + leg.duration;
        if (arrive <= t1 + EPS) {
          const { lim } = il.authority(tr, item, L - tr.G + margin);
          if (lim >= L - EPS) {
            tr.G = L;
            tr.v = 0;
            finishMove(tr, arrive);
            tau = arrive;
            continue;
          }
        } else {
          const gp = G0 + distanceAt(leg, t1 - t0);
          const vp = speedAt(leg, t1 - t0);
          const { lim } = il.authority(
            tr,
            item,
            gp - tr.G + stopDist(vp, k) + margin,
          );
          if (gp + stopDist(vp, k) <= lim + EPS) {
            tr.G = gp;
            tr.v = vp;
            tr.samples.push([t1, gp - item.g0]);
            return;
          }
        }
        // The plan is no longer safe: brake under the authority from here on.
        tr.v = speedAt(leg, Math.max(0, tau - t0));
        tr.prof = undefined;
        tr.offPlan = true;
      }
      const h = t1 - tau;
      if (h <= EPS) return;
      const vmax = k.maxSpeed / 3.6;
      let v1 = Math.min(vmax, tr.v + k.accel * h);
      const { lim, why, by } = il.authority(
        tr,
        item,
        stopDist(v1, k) + v1 * h + margin,
      );
      const target = Math.min(lim, L);
      v1 = Math.min(v1, Math.sqrt(2 * k.decel * Math.max(0, target - tr.G)));
      const g1 = Math.min(tr.G + ((tr.v + v1) / 2) * h, target);
      const moved = g1 > tr.G + 1e-3;
      if (moved && tr.open) {
        tr.open.t1 = tau;
        tr.waits.push(tr.open);
        tr.open = undefined;
      }
      tr.G = Math.max(tr.G, g1);
      tr.v = v1;
      tr.samples.push([t1, Math.min(tr.G, L) - item.g0]);
      if (tr.G >= L - 0.05) {
        tr.G = L;
        tr.v = 0;
        finishMove(tr, t1);
        tau = t1;
        continue;
      }
      if (!moved && v1 < 1e-3) {
        tr.v = 0;
        if (!tr.open) tr.open = { g: tr.G, t0: tau, t1: tau, why };
        tr.open.why = why || tr.open.why;
        if (chains && by && !tr.open.why.includes("["))
          tr.open.why += ` [${by.m.run.id} ${describe(by)}]`;
        noteBlocked(tr, t1, why, item, by);
      } else tr.blockedSince = undefined;
      return;
    }
  };

  const finishMove = (tr: Train, arr: number) => {
    if (tr.open) {
      tr.open.t1 = arr;
      tr.waits.push(tr.open);
      tr.open = undefined;
    }
    const rec: MoveRecord = {
      k: "move",
      dep: tr.itemStart,
      arr,
      waits: tr.waits.filter((w) => w.t1 - w.t0 >= 1),
    };
    const item = tr.m.items[tr.i] as MoveItem;
    if (tr.offPlan) {
      const last = tr.samples[tr.samples.length - 1];
      if (!last || last[0] < arr - EPS)
        tr.samples.push([arr, item.g1 - item.g0]);
      else last[1] = item.g1 - item.g0;
      rec.via = simplify(tr.samples, VIA_TOLERANCE_M);
    }
    tr.records.push(rec);
    tr.waits = [];
    tr.samples = [];
    tr.offPlan = false;
    tr.prof = undefined;
    tr.blockedSince = undefined;
    tr.i++;
    tr.itemStart = tr.m.items[tr.i]?.k === "wait" ? arr : Number.NaN;
    tr.readyAt = arr;
  };

  // --- main loop ---
  const order = [...trains].sort((a, b) => a.start - b.start || a.idx - b.idx);
  let next = 0;
  const active: Train[] = [];
  let t = order.length ? Math.floor(order[0]!.start / dt) * dt : 0;
  const tEnd = Math.max(0, ...models.map((m) => lastPlanned(m))) + 6 * 3600;
  const priority = (tr: Train) => {
    const it = tr.m.items[tr.i];
    const at =
      !it ? Infinity
      : it.k === "wait" ? it.until
      : it.notBefore;
    const deadhead =
      it?.k === "move" && !it.revenue && cfg.revenueFirst ? 1 : 0;
    return { at, deadhead };
  };
  const waiting: Train[] = [];
  let steps = 0;
  while ((next < order.length || active.length || waiting.length) && t < tEnd) {
    if (++steps % YIELD_EVERY_STEPS === 0) yield;
    const t1 = t + dt;
    while (next < order.length && order[next]!.start <= t1)
      waiting.push(order[next++]!);
    for (let j = 0; j < waiting.length; j++) {
      const tr = waiting[j]!;
      if (!il.canSpawn(tr)) {
        if (t1 - tr.start > cfg.maxWaitS)
          forced.push({
            run: tr.m.run.id,
            t: t1,
            seg: tr.m.route[0]?.seg ?? "",
            offset: tr.m.route[0]?.from ?? 0,
            why: "start position occupied",
          });
        else continue;
      }
      tr.active = true;
      // A train held back until its start was clear appears (and starts its plan) now.
      if (t > tr.start) {
        tr.readyAt = t;
        if (tr.m.items[0]?.k === "wait") tr.itemStart = t;
      }
      active.push(tr);
      il.occupy(tr);
      waiting.splice(j--, 1);
    }
    il.clearOccupancy();
    for (const tr of active) {
      il.occupy(tr);
      const pr = priority(tr);
      tr.prAt = pr.at;
      tr.prDeadhead = pr.deadhead;
    }
    active.sort(
      (a, b) => a.prDeadhead - b.prDeadhead || a.prAt - b.prAt || a.idx - b.idx,
    );
    for (const tr of active) {
      advance(tr, Math.max(t, tr.start), t1);
      if (!tr.done) il.release(tr);
      if (traceRun === tr.m.run.id && t1 >= traceFrom && t1 <= traceTo)
        console.log(`[step ${t1}] ${describe(tr)}`);
    }
    for (let j = active.length - 1; j >= 0; j--)
      if (active[j]!.done) active.splice(j, 1);
    t = t1;
  }
  // Anything unfinished (shouldn't happen): record what we have.
  for (const tr of trains) if (!tr.done) il.release(tr, true);
  return { records: trains.map((tr) => tr.records), forced };
}

/** Recorded trajectories are thinned to within this of the simulated motion (m). */
const VIA_TOLERANCE_M = 2;

/** Douglas–Peucker on [t, d] samples, keeping endpoints; tolerance in metres of d. */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ta, da] = pts[a]!;
    const [tb, db] = pts[b]!;
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const [t, d] = pts[i]!;
      const expect = tb > ta ? da + ((db - da) * (t - ta)) / (tb - ta) : da;
      const err = Math.abs(d - expect);
      if (err > wd) {
        wd = err;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function lastPlanned(m: TrainModel): number {
  const it = m.items[m.items.length - 1];
  if (!it) return 0;
  return it.k === "wait" ? it.until : it.plannedEnd;
}
