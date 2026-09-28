// Signalling simulation for the dispatcher (PLAN.md §4.11). All trains of a service day are stepped
// together. A train follows its planned timetable profile exactly while that is safe; otherwise it
// brakes for its movement authority and runs at line speed once released (recovering lost time).
//
// Movement authority is limited by:
// - moving block: the rear of the train ahead on the train's path, less a safety margin;
// - junction locks: one train at a time through a switch or crossing, and not while another train
//   fouls it;
// - section reservations: track used in both directions (single track, stubs, tails, crossovers)
//   is reserved in the direction of travel up to where the train leaves it or reverses (its berth,
//   reserved exclusively). A train never enters such a section while an opposing reservation holds
//   any part of it, so opposing trains can't meet and can't deadlock.
//
// A train blocked longer than `maxWaitS` is given authority anyway (reported), so the simulation
// always ends. Deterministic: no randomness, no wall clock; ties break by timetable, then run id.

import type { Dir, TrackGraph } from '../infra/graph.ts';
import { distanceAt, minLegTime, solveLeg, speedAt, type Kinematics, type LegProfile } from '../movement/kinematics.ts';
import { deadheadKinematics, type MoveItem, type RoutePiece, type TrainModel } from './model.ts';

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

export interface SignalWait {
  /** Route coordinate where the train stood. */
  g: number;
  t0: number;
  t1: number;
  why: string;
}

export interface MoveRecord {
  k: 'move';
  dep: number;
  arr: number;
  waits: SignalWait[];
  /** [t, distance from the move's start] samples, when the train left its planned profile. */
  via?: [number, number][];
}

export interface WaitRecord {
  k: 'wait';
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

interface Interval {
  seg: string;
  lo: number;
  hi: number;
  tr?: Train;
}

interface Reservation {
  tr: Train;
  seg: string;
  dir: Dir;
  excl: boolean;
  g0: number;
  g1: number;
}

interface Train {
  idx: number;
  m: TrainModel;
  kin: Kinematics;
  dkin: Kinematics;
  tkin: Kinematics;
  half: number;
  start: number;
  active: boolean;
  done: boolean;
  i: number;
  G: number;
  v: number;
  /** Route piece containing G. */
  pi: number;
  /** Start of the current wait, or departure of the current move (NaN until it departs). */
  itemStart: number;
  /** When the previous item finished (earliest departure for the next move). */
  readyAt: number;
  prof: { leg: LegProfile; t0: number; G0: number } | undefined;
  open: SignalWait | undefined;
  waits: SignalWait[];
  blockedSince: number | undefined;
  blockedWhy: string;
  /** Trajectory samples of the current move, and whether it left its planned profile. */
  samples: [number, number][];
  offPlan: boolean;
  blockedBy: Train | undefined;
  /** Constraints are ignored until the train passes this route coordinate (deadlock breaker). */
  forcedTo: number;
  res: Reservation[];
  locks: { node: string; x: number; releaseG: number }[];
  /** Junctions inside this train's reserved sections: nobody else may stop on them. */
  routeNodes: { node: string; releaseG: number }[];
  body: Interval[];
  /** Position and item the cached body was computed for. */
  bodyG: number;
  bodyI: number;
  /** Priority this step: empty moves after trains in service, then timetable order. */
  prAt: number;
  prDeadhead: number;
  records: (MoveRecord | WaitRecord)[];
}

/** Fixed lookahead margin beyond the stopping distance, so a request comes a step early (m). */
const LOOKAHEAD_SLACK_M = 10;
/** Trains stop this far short of a fouling point, so they never foul it by rounding (m). */
const CLEAR_M = 2;
const EPS = 1e-6;

export interface SpeedFactors {
  deadhead: number;
  turnback: number;
}

/** Simulation steps between yields (async runs let a server keep answering requests meanwhile). */
const YIELD_EVERY_STEPS = 2000;

/** Run the simulation to completion. */
export function simulate(models: TrainModel[], g: TrackGraph, cfg: DispatchConfig, speeds: SpeedFactors): SimResult {
  const it = simulation(models, g, cfg, speeds);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** The same simulation, yielding to the event loop every few thousand steps (identical result). */
export async function simulateAsync(models: TrainModel[], g: TrackGraph, cfg: DispatchConfig, speeds: SpeedFactors): Promise<SimResult> {
  const it = simulation(models, g, cfg, speeds);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function* simulation(models: TrainModel[], g: TrackGraph, cfg: DispatchConfig, speeds: SpeedFactors): Generator<void, SimResult> {
  const dt = cfg.stepS;
  const F = cfg.foulingM;
  const margin = cfg.safetyMarginM;

  // --- network facts ---
  const incident = new Map<string, { seg: string; end: 0 | 1 }[]>();
  for (const s of g.segments.values()) {
    (incident.get(s.from) ?? incident.set(s.from, []).get(s.from)!).push({ seg: s.id, end: 0 });
    (incident.get(s.to) ?? incident.set(s.to, []).get(s.to)!).push({ seg: s.id, end: 1 });
  }
  const isYard = (seg: string) => g.segment(seg).kind === 'yard';
  const lockable = (node: string) => {
    const ends = incident.get(node) ?? [];
    return ends.length >= 3 && ends.some((e) => !isYard(e.seg));
  };
  // Sections needing reservation: track trains in service use in both directions (single track,
  // stub platforms), crossovers, reversal tracks, and non-revenue track used both ways (leads).
  // Elsewhere a train running against the normal direction of traffic reserves the pieces it runs
  // "wrong road", and other trains treat that reservation as a stop.
  const revenueDirs = new Map<string, number>();
  const anyDirs = new Map<string, number>();
  for (const m of models) {
    for (const it of m.items) {
      if (it.k !== 'move') continue;
      for (const p of m.route) {
        if (p.g0 < it.g0 - EPS || p.g1 > it.g1 + EPS) continue;
        const bit = p.dir === 1 ? 1 : 2;
        anyDirs.set(p.seg, (anyDirs.get(p.seg) ?? 0) | bit);
        if (it.revenue) revenueDirs.set(p.seg, (revenueDirs.get(p.seg) ?? 0) | bit);
      }
    }
  }
  const interlocked = new Set<string>();
  for (const [seg, d] of anyDirs) {
    const kind = g.segment(seg).kind;
    if (kind === 'yard') continue;
    const rev = revenueDirs.get(seg);
    if (kind === 'crossover' || kind === 'tail' || kind === 'pocket' || kind === 'siding' || rev === 3 || (rev === undefined && d === 3)) interlocked.add(seg);
  }
  const wrongRoad = (p: RoutePiece) => {
    const rev = revenueDirs.get(p.seg);
    return rev !== undefined && rev !== 3 && rev !== (p.dir === 1 ? 1 : 2);
  };
  const needsReservation = (p: RoutePiece) => interlocked.has(p.seg) || wrongRoad(p);

  // --- trains ---
  const trains: Train[] = models.map((m, idx) => {
    const first = m.items[0]!;
    const start = first.k === 'wait' ? first.t0 : first.notBefore;
    return {
      idx,
      m,
      kin: m.kin,
      dkin: deadheadKinematics(m.kin, speeds.deadhead),
      tkin: deadheadKinematics(m.kin, speeds.turnback),
      half: m.length / 2,
      start,
      active: false,
      done: m.items.length === 0,
      i: 0,
      G: 0,
      v: 0,
      pi: 0,
      itemStart: first.k === 'wait' ? start : Number.NaN,
      readyAt: start,
      prof: undefined,
      open: undefined,
      waits: [],
      blockedSince: undefined,
      blockedWhy: '',
      samples: [],
      offPlan: false,
      blockedBy: undefined,
      forcedTo: -Infinity,
      res: [],
      locks: [],
      routeNodes: [],
      body: [],
      bodyG: Number.NaN,
      bodyI: -1,
      prAt: 0,
      prDeadhead: 0,
      records: [],
    };
  });
  const forced: ForcedGrant[] = [];
  const nodeLocks = new Map<string, Train>();
  const reservations = new Map<string, Reservation[]>();
  const occupancy = new Map<string, Interval[]>();
  const occupy = (tr: Train) => {
    if (tr.G !== tr.bodyG || tr.i !== tr.bodyI) {
      tr.body = bodyOf(tr);
      for (const iv of tr.body) iv.tr = tr;
      tr.bodyG = tr.G;
      tr.bodyI = tr.i;
    }
    for (const iv of tr.body) {
      let list = occupancy.get(iv.seg);
      if (!list) occupancy.set(iv.seg, (list = []));
      list.push(iv);
    }
  };

  const kinOf = (tr: Train, item: MoveItem) => (item.revenue ? tr.kin : item.kind === 'turnback' ? tr.tkin : tr.dkin);
  /**
   * The route piece containing the train's centre. At a piece boundary a waiting train stays on the
   * piece it arrived on (at a reversal, the inbound one); a train in a move takes the next piece.
   */
  const pieceAt = (tr: Train) => {
    const r = tr.m.route;
    const moving = tr.m.items[tr.i]?.k === 'move';
    while (tr.pi < r.length - 1 && (r[tr.pi]!.g1 < tr.G - EPS || (moving && r[tr.pi]!.g1 <= tr.G + EPS))) tr.pi++;
    return r[tr.pi];
  };
  const offOf = (p: RoutePiece, x: number) => p.from + (x - p.g0) * p.dir;

  // --- body (occupied track) ---
  const graphExtend = (out: Interval[], seg: string, dir: Dir, dist: number) => {
    let s = seg;
    let d = dir;
    let rem = dist;
    for (let guard = 0; guard < 20 && rem > EPS; guard++) {
      const nx = g.straightest(s, d);
      if (!nx) return;
      const ns = g.segment(nx.seg);
      const take = Math.min(ns.length, rem);
      out.push(nx.dir === 1 ? { seg: nx.seg, lo: 0, hi: take } : { seg: nx.seg, lo: ns.length - take, hi: ns.length });
      rem -= take;
      s = nx.seg;
      d = nx.dir;
    }
  };
  const addSpan = (out: Interval[], p: RoutePiece, xa: number, xb: number) => {
    const a = offOf(p, xa);
    const b = offOf(p, xb);
    if (Math.abs(b - a) > EPS) out.push({ seg: p.seg, lo: Math.min(a, b), hi: Math.max(a, b) });
  };
  const bodyOf = (tr: Train): Interval[] => {
    const r = tr.m.route;
    const out: Interval[] = [];
    if (!r.length) return out;
    pieceAt(tr);
    // Forward.
    let q = tr.pi;
    let x = tr.G;
    let rem = tr.half;
    for (;;) {
      const p = r[q]!;
      const take = Math.max(0, Math.min(p.g1 - x, rem));
      addSpan(out, p, x, x + take);
      rem -= take;
      x += take;
      if (rem <= EPS) break;
      const nx = r[q + 1];
      if (nx && !nx.rev && Math.abs(nx.g0 - p.g1) < EPS && x >= p.g1 - EPS) {
        q++;
        continue;
      }
      graphExtend(out, p.seg, p.dir, rem);
      break;
    }
    // Backward.
    q = tr.pi;
    x = tr.G;
    rem = tr.half;
    for (;;) {
      const p = r[q]!;
      const take = Math.max(0, Math.min(x - p.g0, rem));
      addSpan(out, p, x - take, x);
      rem -= take;
      x -= take;
      if (rem <= EPS) break;
      if (!p.rev && q > 0 && x <= p.g0 + EPS) {
        q--;
        continue;
      }
      graphExtend(out, p.seg, (-p.dir) as Dir, rem);
      break;
    }
    return out.filter((iv) => !isYard(iv.seg));
  };

  const foulerOf = (node: string, tr: Train): Train | undefined => {
    for (const e of incident.get(node) ?? []) {
      const len = g.segment(e.seg).length;
      for (const o of occupancy.get(e.seg) ?? []) if (o.tr !== tr && (e.end === 0 ? o.lo < F : o.hi > len - F)) return o.tr;
    }
    return undefined;
  };
  const fouled = (node: string, tr: Train) => {
    for (const e of incident.get(node) ?? []) {
      const len = g.segment(e.seg).length;
      for (const o of occupancy.get(e.seg) ?? []) {
        if (o.tr === tr) continue;
        if (e.end === 0 ? o.lo < F : o.hi > len - F) return true;
      }
    }
    return false;
  };

  // --- section reservations ---
  const covered = (tr: Train, p: RoutePiece) => tr.res.some((r) => r.seg === p.seg && r.dir === p.dir && r.g0 <= p.g0 + EPS && r.g1 >= p.g1 - EPS);
  /** Reserve the section starting at route piece q; returns '' on success, else the reason. */
  let conflictWith: Train | undefined;
  const nodeAt = (p: RoutePiece, atEnd: boolean) => {
    const sg = g.segment(p.seg);
    return (p.dir === 1) === atEnd ? sg.to : sg.from;
  };
  let routeNodes: [string, number][] = [];
  const routeHolder = new Map<string, Train>();
  const requestSection = (tr: Train, q: number): string => {
    routeNodes = [];
    const r = tr.m.route;
    const want: Omit<Reservation, 'tr'>[] = [];
    let endsAtBerth = false;
    let end = r[q]!.g0;
    for (let j = q; j < r.length; j++) {
      const p = r[j]!;
      if (j > q && p.rev) break;
      if (!needsReservation(p)) break;
      const nx = r[j + 1];
      const excl = Boolean(nx?.rev) || !nx;
      if (!covered(tr, p) || excl) want.push({ seg: p.seg, dir: p.dir, excl, g0: p.g0, g1: p.g1 });
      end = p.g1;
      if (excl) {
        endsAtBerth = true;
        break;
      }
    }
    // Nor while another train fouls a junction at either end of it or inside it.
    if (want.length) {
      const nodes = new Map<string, number>();
      for (let j = q; j < r.length && r[j]!.g0 < end - EPS; j++) {
        if (j > q && r[j]!.rev) break;
        if (!nodes.has(nodeAt(r[j]!, false))) nodes.set(nodeAt(r[j]!, false), r[j]!.g0);
        nodes.set(nodeAt(r[j]!, true), r[j]!.g1);
      }
      for (const [node] of nodes) {
        if (!lockable(node)) continue;
        const f = foulerOf(node, tr);
        if (f && !want.some((w) => (reservations.get(w.seg) ?? []).some((x) => x.tr === f))) {
          conflictWith = f;
          return 'track occupied';
        }
      }
      routeNodes = [...nodes].filter(([node, x]) => lockable(node) && x > tr.G - tr.half);
    }
    // Don't enter a section without room to clear it at the far end (else the train stands in it,
    // blocking opposing trains, while it queues behind the train ahead).
    if (!endsAtBerth && !clearBeyond(tr, end, 2 * tr.half + margin)) {
      conflictWith = lastObstacle;
      return 'no room beyond the section';
    }
    // Time to clear the whole section from a standstill (conservative), for crossing moves.
    const clearAt = now + minLegTime(Math.max(0, end - (tr.G + tr.half)) + 2 * tr.half, tr.kin) + cfg.crossingBufferS;
    for (const w of want) {
      for (const o of reservations.get(w.seg) ?? []) {
        if (o.tr === tr) continue;
        conflictWith = o.tr;
        if (o.excl || w.excl) return 'berth or stub track occupied';
        if (o.dir !== w.dir && !(endsAtBerth === false && earliestArrival(o) >= clearAt)) return 'opposing train on single track';
      }
      // Another train on the part of the segment this train will run over (not elsewhere on it).
      const piece = r.find((p) => p.seg === w.seg && Math.abs(p.g0 - w.g0) < EPS)!;
      const lo = Math.min(piece.from, piece.to);
      const hi = Math.max(piece.from, piece.to);
      for (const o of occupancy.get(w.seg) ?? []) {
        if (o.tr === tr || o.hi <= lo || o.lo >= hi) continue;
        conflictWith = o.tr;
        if (!(reservations.get(w.seg) ?? []).some((x) => x.tr === o.tr)) return 'track occupied';
      }
    }
    for (const w of want) {
      const res = { ...w, tr };
      tr.res.push(res);
      (reservations.get(w.seg) ?? reservations.set(w.seg, []).get(w.seg)!).push(res);
    }
    // The section's junctions: others may pass through them (they check there's room to clear)
    // but not stop on them before this train has passed.
    for (const [node, x] of routeNodes) {
      if (!routeHolder.has(node)) routeHolder.set(node, tr);
      tr.routeNodes.push({ node, releaseG: x + F + tr.half });
    }
    routeNodes = [];
    return '';
  };
  /** The soonest a reservation's holder could reach it: remaining dwell, then line speed all the way. */
  const earliestArrival = (o: Reservation): number => {
    const h = o.tr;
    const dist = o.g0 - (h.G + h.half);
    if (dist <= 0) return -Infinity;
    const it = h.m.items[h.i];
    const wait = it?.k === 'wait' ? Math.max(0, Math.max(it.until, h.itemStart + it.minDur) - now) : it?.k === 'move' && Number.isNaN(h.itemStart) ? Math.max(0, it.notBefore - now) : 0;
    return now + wait + dist / (h.kin.maxSpeed / 3.6);
  };
  const release = (tr: Train, all = false) => {
    const tail = tr.G - tr.half;
    tr.res = tr.res.filter((r) => {
      if (!all && r.g1 >= tail) return true;
      const list = reservations.get(r.seg)!;
      list.splice(list.indexOf(r), 1);
      return false;
    });
    tr.locks = tr.locks.filter((l) => {
      if (!all && l.releaseG >= tr.G) return true;
      if (nodeLocks.get(l.node) === tr) nodeLocks.delete(l.node);
      return false;
    });
    tr.routeNodes = tr.routeNodes.filter((l) => {
      if (!all && l.releaseG >= tr.G) return true;
      if (routeHolder.get(l.node) === tr) routeHolder.delete(l.node);
      return false;
    });
  };

  /** Whether the train's route from x for `dist` metres (up to its next reversal) is free of other trains. */
  let lastObstacle: Train | undefined;
  const clearBeyond = (tr: Train, x: number, dist: number): boolean => {
    if (dist <= 0) return true;
    const r = tr.m.route;
    let q = tr.pi;
    while (q < r.length - 1 && r[q]!.g1 <= x) q++;
    for (; q < r.length; q++) {
      const p = r[q]!;
      if (p.g0 >= x + dist) break;
      if (p.rev && p.g0 > tr.G + EPS) break;
      const a = Math.max(x, p.g0);
      const b = Math.min(x + dist, p.g1);
      const lo = Math.min(offOf(p, a), offOf(p, b));
      const hi = Math.max(offOf(p, a), offOf(p, b));
      for (const o of occupancy.get(p.seg) ?? []) {
        if (o.tr !== tr && o.lo < hi - EPS && lo + EPS < o.hi) {
          lastObstacle = o.tr;
          return false;
        }
      }
    }
    return true;
  };

  // --- movement authority ---
  /** Scratch state of the authority being computed (one at a time; avoids per-call closures). */
  const A: { lim: number; why: string; by: Train | undefined } = { lim: Infinity, why: '', by: undefined };
  const blockAt = (at: number, reason: string, who?: Train) => {
    if (at < A.lim) {
      A.lim = at;
      A.why = reason;
      A.by = who;
    }
  };
  const reachable = (stopAt: number) => A.lim >= stopAt - EPS;
  /**
   * How far (route coordinate of the train's centre) the train may go during the current move.
   * Acquires junction locks and section reservations it needs within `need` metres of its head.
   */
  const authority = (tr: Train, item: MoveItem, need: number): { lim: number; why: string; by?: Train } => {
    if (tr.G < tr.forcedTo) return { lim: Infinity, why: '' };
    const r = tr.m.route;
    const head = tr.G + tr.half;
    const k = kinOf(tr, item);
    const vmax = k.maxSpeed / 3.6;
    const scan = vmax * vmax / (2 * k.decel) + vmax * dt + margin + tr.half + F + LOOKAHEAD_SLACK_M;
    A.lim = Infinity;
    A.why = '';
    A.by = undefined;
    pieceAt(tr);
    // Resources (sections, junctions) are only taken in path order and only when the train can
    // reach them (reachable()): a train never holds a lock or reservation while it waits for
    // something before it.
    const tail = tr.G - tr.half;
    for (let q = tr.pi; q < r.length; q++) {
      const p = r[q]!;
      if (p.g0 > head + scan || p.g0 >= item.g1 + tr.half) break;
      if (q > tr.pi && p.rev) break;
      const inside = p.g0 <= head - EPS;
      const stopAt = inside ? tr.G : p.g0 - F - CLEAR_M - tr.half;
      // Track beyond this move's stop (and beyond the train's front when it stands there) is
      // requested when the train leaves the stop, not before.
      const beyondStop = p.g0 >= item.g1 + tr.half - EPS;
      if (traceRun === tr.m.run.id && now >= traceFrom && now <= traceTo) console.log(`  [auth ${now}] q=${q} ${p.seg}${p.dir > 0 ? '+' : '-'} g0=${p.g0.toFixed(1)} head=${head.toFixed(1)} need=${need.toFixed(1)} needsRes=${needsReservation(p)} covered=${covered(tr, p)} A.lim=${A.lim.toFixed(1)} stopAt=${stopAt.toFixed(1)} beyond=${beyondStop}`);
      if (!beyondStop && p.g1 > tail + EPS && !covered(tr, p)) {
        if (needsReservation(p)) {
          // Never enter a section you can't leave: reserve it through to where it ends or reverses.
          if (p.g0 - head <= need + F && reachable(stopAt)) {
            const reason = requestSection(tr, q);
            if (reason) blockAt(stopAt, reason, conflictWith);
          } else if (!inside) blockAt(stopAt, 'section ahead');
        } else {
          // Someone running against traffic here holds it.
          for (const o of reservations.get(p.seg) ?? []) {
            if (o.tr !== tr && (o.dir !== p.dir || o.excl)) {
              blockAt(stopAt, 'opposing move', o.tr);
              break;
            }
          }
        }
      }
      // Moving block: other trains on this piece of my path.
      for (const o of occupancy.get(p.seg) ?? []) {
        if (o.tr === tr) continue;
        const lo = Math.max(Math.min(p.from, p.to), o.lo);
        const hi = Math.min(Math.max(p.from, p.to), o.hi);
        if (hi - lo <= EPS) continue;
        const xa = p.g0 + (lo - p.from) * p.dir;
        const xb = p.g0 + (hi - p.from) * p.dir;
        const near = Math.min(xa, xb);
        const far = Math.max(xa, xb);
        if (far <= head + EPS) continue;
        blockAt(near < head ? tr.G : near - margin - tr.half, 'train ahead', o.tr);
      }
      if (A.lim < p.g0) break;
      // Junction at the end of this piece.
      const nx = r[q + 1];
      if (nx && !nx.rev && nx.seg !== p.seg) {
        const node = p.dir === 1 ? g.segment(p.seg).to : g.segment(p.seg).from;
        const x = p.g1;
        const at = x - F - CLEAR_M - tr.half;
        if (x > tr.G && x < item.g1 + tr.half - EPS && x - head <= need + F && lockable(node) && nodeLocks.get(node) !== tr) {
          if (!reachable(at)) break;
          // Reserve the section beyond the junction first, so a refusal doesn't leave the junction locked.
          if (needsReservation(nx) && !covered(tr, nx)) {
            const reason = requestSection(tr, q + 1);
            if (reason) {
              blockAt(at, reason, conflictWith);
              break;
            }
          }
          if (nodeLocks.has(node) || fouled(node, tr)) {
            blockAt(at, 'junction', nodeLocks.get(node) ?? foulerOf(node, tr));
            break;
          }
          // Stopping on a junction another train's section runs through would trap that train.
          const rh = routeHolder.get(node);
          if (rh && rh !== tr && x > item.g1 - tr.half - F - EPS) {
            blockAt(at, 'junction (route set for another train)', rh);
            break;
          }
          // Only set a route through a junction the train can clear (unless it stops on it by plan).
          if (!clearBeyond(tr, x, Math.min(F + 2 * tr.half + margin, item.g1 + tr.half - x))) {
            blockAt(at, 'junction (no room beyond)', lastObstacle);
            break;
          }
          nodeLocks.set(node, tr);
          tr.locks.push({ node, x, releaseG: x + F + tr.half });
        }
      }
    }
    // Wherever the train stops, it mustn't foul a junction on another train's reserved route.
    if (A.lim < item.g1 + tr.half) {
      for (let q = tr.pi; q < r.length - 1; q++) {
        const p = r[q]!;
        const x = p.g1;
        if (x > A.lim + tr.half + F) break;
        if (r[q + 1]!.rev || x <= tr.G + tr.half - EPS) continue;
        const node = p.dir === 1 ? g.segment(p.seg).to : g.segment(p.seg).from;
        const rh = routeHolder.get(node);
        if (rh && rh !== tr && x - F - tr.half < A.lim) {
          blockAt(Math.max(tr.G, x - F - CLEAR_M - tr.half), 'junction (route set for another train)', rh);
          break;
        }
      }
    }
    // Give back junctions beyond where the train must now stop: it can't use them yet, and holding
    // them could block the very train it waits for.
    if (A.lim < Infinity) {
      tr.locks = tr.locks.filter((l) => {
        if (l.x - F <= A.lim + tr.half + EPS || l.x <= head) return true;
        if (nodeLocks.get(l.node) === tr) nodeLocks.delete(l.node);
        return false;
      });
    }
    return A.by ? { lim: A.lim, why: A.why, by: A.by } : { lim: A.lim, why: A.why };
  };

  const stopDist = (v: number, k: Kinematics) => (v * v) / (2 * k.decel);

  const traceRun = typeof process !== 'undefined' ? process.env?.DISPATCH_TRACE : undefined;
  const traceFrom = Number((typeof process !== 'undefined' && process.env?.DISPATCH_TRACE_FROM) || 0);
  const traceTo = Number((typeof process !== 'undefined' && process.env?.DISPATCH_TRACE_TO) || 0);
  const noteBlocked = (tr: Train, t: number, why: string, item: MoveItem, by?: Train) => {
    if (traceRun === tr.m.run.id && Math.round(t) % 15 === 0) console.log(`[trace ${Math.round(t)}] ${describe(tr)} :: ${by ? describe(by) : ''}`);
    if (tr.blockedSince === undefined) tr.blockedSince = t;
    tr.blockedWhy = why;
    tr.blockedBy = by;
    if (t - tr.blockedSince > cfg.maxWaitS) {
      if (debug && !forced.length) dumpChain(tr, t);
      const p = tr.m.route[tr.pi]!;
      forced.push({ run: tr.m.run.id, t, seg: p.seg, offset: offOf(p, Math.min(Math.max(tr.G, p.g0), p.g1)), why });
      tr.forcedTo = item.g1;
      tr.blockedSince = undefined;
    }
  };

  const debug = typeof process !== 'undefined' && Boolean(process.env?.DISPATCH_DEBUG);
  const describe = (tr: Train) => {
    const p = tr.m.route[tr.pi];
    const it = tr.m.items[tr.i];
    const res = tr.res.map((r) => `${r.seg}${r.dir > 0 ? '+' : '-'}${r.excl ? '!' : ''}`).join(' ');
    return `${tr.m.run.id} item ${tr.i}/${tr.m.items.length} ${it?.k}${it?.k === 'move' ? (it.revenue ? ' rev' : ' dh') : ''} at ${p?.seg}@${p ? offOf(p, Math.min(Math.max(tr.G, p.g0), p.g1)).toFixed(0) : '?'} ${p?.dir} v=${tr.v.toFixed(1)} blocked=${tr.blockedWhy}${tr.blockedBy ? ` by ${tr.blockedBy.m.run.id}` : ''} res=[${res}] locks=[${tr.locks.map((l) => l.node).join(' ')}]`;
  };
  const dumpChain = (tr: Train, t: number) => {
    console.log(`[dispatch] first deadlock at ${t}:`);
    const seen = new Set<Train>();
    for (let x: Train | undefined = tr; x && !seen.has(x); x = x.blockedBy) {
      seen.add(x);
      console.log('  ' + describe(x));
    }
  };

  let now = 0;

  // --- one step for one train ---
  const advance = (tr: Train, t: number, t1: number) => {
    let tau = t;
    now = t;
    for (let guard = 0; guard < 50; guard++) {
      const item = tr.m.items[tr.i];
      if (!item) {
        tr.done = true;
        release(tr, true);
        return;
      }
      if (item.k === 'wait') {
        const end = Math.max(item.until, tr.itemStart + item.minDur);
        if (end > t1) return;
        tr.records.push({ k: 'wait', t0: tr.itemStart, t1: end });
        tr.i++;
        tr.itemStart = Number.NaN;
        tau = Math.max(tau, end);
        tr.itemStart = tr.m.items[tr.i]?.k === 'wait' ? end : Number.NaN;
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
        const duration = onTime ? item.plannedEnd - item.notBefore : Math.max(minLegTime(dist, k), item.plannedEnd - tau);
        const leg = solveLeg(dist, duration, k);
        const tt = Math.min(t1 - tau, leg.duration);
        const gp = tr.G + distanceAt(leg, tt);
        const vp = speedAt(leg, tt);
        const { lim, why, by } = authority(tr, item, Math.max(gp - tr.G + stopDist(vp, k), LOOKAHEAD_SLACK_M) + margin);
        if (gp + stopDist(vp, k) <= lim + EPS || (tt >= leg.duration && lim >= L - EPS)) {
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
          const { lim } = authority(tr, item, L - tr.G + margin);
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
          const { lim } = authority(tr, item, gp - tr.G + stopDist(vp, k) + margin);
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
      const { lim, why, by } = authority(tr, item, stopDist(v1, k) + v1 * h + margin);
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
        if (debug && by && !tr.open.why.includes('[')) tr.open.why += ` [${by.m.run.id} ${describe(by)}]`;
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
    const rec: MoveRecord = { k: 'move', dep: tr.itemStart, arr, waits: tr.waits.filter((w) => w.t1 - w.t0 >= 1) };
    const item = tr.m.items[tr.i] as MoveItem;
    if (tr.offPlan) {
      const last = tr.samples[tr.samples.length - 1];
      if (!last || last[0] < arr - EPS) tr.samples.push([arr, item.g1 - item.g0]);
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
    tr.itemStart = tr.m.items[tr.i]?.k === 'wait' ? arr : Number.NaN;
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
    const at = !it ? Infinity : it.k === 'wait' ? it.until : it.notBefore;
    const deadhead = it?.k === 'move' && !it.revenue && cfg.revenueFirst ? 1 : 0;
    return { at, deadhead };
  };
  /** A train appears (leaves the yard, or is found at its first platform) only where that's free. */
  const canSpawn = (tr: Train) => {
    const body = bodyOf(tr);
    for (const iv of body) {
      for (const o of occupancy.get(iv.seg) ?? []) if (o.tr !== tr && o.lo < iv.hi && iv.lo < o.hi) return false;
      if ((reservations.get(iv.seg) ?? []).some((o) => o.tr !== tr)) return false;
      // Nor may it appear fouling a junction another train is using or about to use.
      const sg = g.segment(iv.seg);
      for (const [node, near] of [[sg.from, iv.lo < F] as const, [sg.to, iv.hi > sg.length - F] as const]) {
        if (!near || !lockable(node)) continue;
        const holder = nodeLocks.get(node) ?? routeHolder.get(node);
        if ((holder && holder !== tr) || fouled(node, tr)) return false;
      }
    }
    const p = pieceAt(tr);
    if (p && needsReservation(p) && !covered(tr, p) && body.length) return requestSection(tr, tr.pi) === '';
    return true;
  };
  const waiting: Train[] = [];
  let steps = 0;
  while ((next < order.length || active.length || waiting.length) && t < tEnd) {
    if (++steps % YIELD_EVERY_STEPS === 0) yield;
    const t1 = t + dt;
    while (next < order.length && order[next]!.start <= t1) waiting.push(order[next++]!);
    for (let j = 0; j < waiting.length; j++) {
      const tr = waiting[j]!;
      if (!canSpawn(tr)) {
        if (t1 - tr.start > cfg.maxWaitS) forced.push({ run: tr.m.run.id, t: t1, seg: tr.m.route[0]?.seg ?? '', offset: tr.m.route[0]?.from ?? 0, why: 'start position occupied' });
        else continue;
      }
      tr.active = true;
      // A train held back until its start was clear appears (and starts its plan) now.
      if (t > tr.start) {
        tr.readyAt = t;
        if (tr.m.items[0]?.k === 'wait') tr.itemStart = t;
      }
      active.push(tr);
      occupy(tr);
      waiting.splice(j--, 1);
    }
    for (const list of occupancy.values()) list.length = 0;
    for (const tr of active) {
      occupy(tr);
      const pr = priority(tr);
      tr.prAt = pr.at;
      tr.prDeadhead = pr.deadhead;
    }
    active.sort((a, b) => a.prDeadhead - b.prDeadhead || a.prAt - b.prAt || a.idx - b.idx);
    for (const tr of active) {
      advance(tr, Math.max(t, tr.start), t1);
      if (!tr.done) release(tr);
      if (traceRun === tr.m.run.id && t1 >= traceFrom && t1 <= traceTo) console.log(`[step ${t1}] ${describe(tr)}`);
    }
    for (let j = active.length - 1; j >= 0; j--) if (active[j]!.done) active.splice(j, 1);
    t = t1;
  }
  // Anything unfinished (shouldn't happen): record what we have.
  for (const tr of trains) if (!tr.done) release(tr, true);
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
  return it.k === 'wait' ? it.until : it.plannedEnd;
}
