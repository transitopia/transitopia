// The dispatcher's interlocking (packages/transit-core/DESIGN.md#dispatcher): what track each train
// occupies, the sections it has reserved and the junctions it has locked, and from those the
// movement authority it's given. sim.ts steps the trains; this decides how far each may go.
//
// Movement authority is limited by:
// - moving block: the rear of the train ahead on the train's path, less a safety margin;
// - junction locks: one train at a time through a switch or crossing, and not while another train
//   fouls it;
// - section reservations: track used in both directions (single track, stubs, tails, crossovers)
//   is reserved in the direction of travel up to where the train leaves it or reverses (its berth,
//   reserved exclusively). A train never enters such a section while an opposing reservation holds
//   any part of it, so opposing trains can't meet and can't deadlock.

import type { Dir, TrackGraph } from "../infra/graph.ts";
import {
  minLegTime,
  type Kinematics,
  type LegProfile,
} from "../movement/kinematics.ts";
import {
  deadheadKinematics,
  type MoveItem,
  type RoutePiece,
  type TrainModel,
} from "./model.ts";
import type {
  DispatchConfig,
  DispatchDebug,
  MoveRecord,
  SignalWait,
  SpeedFactors,
  WaitRecord,
} from "./sim.ts";

/** Track a train occupies on a segment, [lo, hi] (m). */
export interface Interval {
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

/** A train in the simulation: its plan, where it is, and what it holds. */
export interface Train {
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

/** A train for a model, before it appears (see Interlocking.canSpawn). */
export function createTrain(
  m: TrainModel,
  idx: number,
  speeds: SpeedFactors,
): Train {
  const first = m.items[0]!;
  const start = first.k === "wait" ? first.t0 : first.notBefore;
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
    itemStart: first.k === "wait" ? start : Number.NaN,
    readyAt: start,
    prof: undefined,
    open: undefined,
    waits: [],
    blockedSince: undefined,
    blockedWhy: "",
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
}

/** Why a train can't have what it asked for, and the train in the way (if one is). */
export interface Refusal {
  why: string;
  by: Train | undefined;
}

/** How far a train may go: the route coordinate of its centre, why no further, and who's in the way. */
export interface Authority {
  lim: number;
  why: string;
  by?: Train;
}

/** Fixed lookahead margin beyond the stopping distance, so a request comes a step early (m). */
export const LOOKAHEAD_SLACK_M = 10;
/** Trains stop this far short of a fouling point, so they never foul it by rounding (m). */
const CLEAR_M = 2;
export const EPS = 1e-6;

/** Offset on its segment of route coordinate x on piece p. */
export const offOf = (p: RoutePiece, x: number): number =>
  p.from + (x - p.g0) * p.dir;

/** Braking distance from speed v (m/s). */
export const stopDist = (v: number, k: Kinematics): number =>
  (v * v) / (2 * k.decel);

/** The kinematics a train moves with on an item: in service, turning back, or running empty. */
export const kinOf = (tr: Train, item: MoveItem): Kinematics =>
  item.revenue ? tr.kin
  : item.kind === "turnback" ? tr.tkin
  : tr.dkin;

/**
 * The route piece containing the train's centre. At a piece boundary a waiting train stays on the
 * piece it arrived on (at a reversal, the inbound one); a train in a move takes the next piece.
 */
export function pieceAt(tr: Train): RoutePiece | undefined {
  const r = tr.m.route;
  const moving = tr.m.items[tr.i]?.k === "move";
  while (
    tr.pi < r.length - 1
    && (r[tr.pi]!.g1 < tr.G - EPS || (moving && r[tr.pi]!.g1 <= tr.G + EPS))
  )
    tr.pi++;
  return r[tr.pi];
}

export class Interlocking {
  /**
   * The time of the step being simulated: the driver sets it as it advances each train (so trains
   * appearing at the start of a step see the time of the last one advanced).
   */
  now = 0;

  private readonly g: TrackGraph;
  private readonly cfg: DispatchConfig;
  private readonly F: number;
  private readonly margin: number;
  private readonly trace: DispatchDebug["trace"];
  /** Per node: the segment ends meeting there. */
  private readonly incident = new Map<string, { seg: string; end: 0 | 1 }[]>();
  /** Per segment: the directions trains in service use it in (bit 1 forward, bit 2 back). */
  private readonly revenueDirs = new Map<string, number>();
  /** Segments that are reserved before use (see the constructor). */
  private readonly interlocked = new Set<string>();

  private readonly nodeLocks = new Map<string, Train>();
  private readonly reservations = new Map<string, Reservation[]>();
  private readonly occupancy = new Map<string, Interval[]>();
  /** Junctions inside reserved sections, by the train that reserved them. */
  private readonly routeHolder = new Map<string, Train>();
  /** Scratch state of the authority being computed (one at a time; avoids per-call closures). */
  private readonly A: { lim: number; why: string; by: Train | undefined } = {
    lim: Infinity,
    why: "",
    by: undefined,
  };

  constructor(
    models: TrainModel[],
    g: TrackGraph,
    cfg: DispatchConfig,
    trace: DispatchDebug["trace"],
  ) {
    this.g = g;
    this.cfg = cfg;
    this.F = cfg.foulingM;
    this.margin = cfg.safetyMarginM;
    this.trace = trace;
    for (const s of g.segments.values()) {
      (
        this.incident.get(s.from) ?? this.incident.set(s.from, []).get(s.from)!
      ).push({ seg: s.id, end: 0 });
      (this.incident.get(s.to) ?? this.incident.set(s.to, []).get(s.to)!).push({
        seg: s.id,
        end: 1,
      });
    }
    // Sections needing reservation: track trains in service use in both directions (single track,
    // stub platforms), crossovers, reversal tracks, and non-revenue track used both ways (leads).
    // Elsewhere a train running against the normal direction of traffic reserves the pieces it runs
    // "wrong road", and other trains treat that reservation as a stop.
    const anyDirs = new Map<string, number>();
    for (const m of models) {
      for (const it of m.items) {
        if (it.k !== "move") continue;
        for (const p of m.route) {
          if (p.g0 < it.g0 - EPS || p.g1 > it.g1 + EPS) continue;
          const bit = p.dir === 1 ? 1 : 2;
          anyDirs.set(p.seg, (anyDirs.get(p.seg) ?? 0) | bit);
          if (it.revenue)
            this.revenueDirs.set(
              p.seg,
              (this.revenueDirs.get(p.seg) ?? 0) | bit,
            );
        }
      }
    }
    for (const [seg, d] of anyDirs) {
      const kind = g.segment(seg).kind;
      if (kind === "yard") continue;
      const rev = this.revenueDirs.get(seg);
      if (
        kind === "crossover"
        || kind === "tail"
        || kind === "pocket"
        || kind === "siding"
        || rev === 3
        || (rev === undefined && d === 3)
      )
        this.interlocked.add(seg);
    }
  }

  private isYard(seg: string): boolean {
    return this.g.segment(seg).kind === "yard";
  }

  /** A junction (three or more segment ends, not all yard track): one train through it at a time. */
  private lockable(node: string): boolean {
    const ends = this.incident.get(node) ?? [];
    return ends.length >= 3 && ends.some((e) => !this.isYard(e.seg));
  }

  private wrongRoad(p: RoutePiece): boolean {
    const rev = this.revenueDirs.get(p.seg);
    return rev !== undefined && rev !== 3 && rev !== (p.dir === 1 ? 1 : 2);
  }

  private needsReservation(p: RoutePiece): boolean {
    return this.interlocked.has(p.seg) || this.wrongRoad(p);
  }

  // --- occupancy ---

  /** Forget where trains were: each step, occupancy is rebuilt with occupy(). */
  clearOccupancy(): void {
    for (const list of this.occupancy.values()) list.length = 0;
  }

  /** Record the track the train occupies now. */
  occupy(tr: Train): void {
    if (tr.G !== tr.bodyG || tr.i !== tr.bodyI) {
      tr.body = this.bodyOf(tr);
      for (const iv of tr.body) iv.tr = tr;
      tr.bodyG = tr.G;
      tr.bodyI = tr.i;
    }
    for (const iv of tr.body) {
      let list = this.occupancy.get(iv.seg);
      if (!list) this.occupancy.set(iv.seg, (list = []));
      list.push(iv);
    }
  }

  private graphExtend(out: Interval[], seg: string, dir: Dir, dist: number) {
    let s = seg;
    let d = dir;
    let rem = dist;
    for (let guard = 0; guard < 20 && rem > EPS; guard++) {
      const nx = this.g.straightest(s, d);
      if (!nx) return;
      const ns = this.g.segment(nx.seg);
      const take = Math.min(ns.length, rem);
      out.push(
        nx.dir === 1 ?
          { seg: nx.seg, lo: 0, hi: take }
        : { seg: nx.seg, lo: ns.length - take, hi: ns.length },
      );
      rem -= take;
      s = nx.seg;
      d = nx.dir;
    }
  }

  private static addSpan(
    out: Interval[],
    p: RoutePiece,
    xa: number,
    xb: number,
  ) {
    const a = offOf(p, xa);
    const b = offOf(p, xb);
    if (Math.abs(b - a) > EPS)
      out.push({ seg: p.seg, lo: Math.min(a, b), hi: Math.max(a, b) });
  }

  /** The track the train's body covers (yard track excepted), from its route, else the straightest way. */
  private bodyOf(tr: Train): Interval[] {
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
      Interlocking.addSpan(out, p, x, x + take);
      rem -= take;
      x += take;
      if (rem <= EPS) break;
      const nx = r[q + 1];
      if (nx && !nx.rev && Math.abs(nx.g0 - p.g1) < EPS && x >= p.g1 - EPS) {
        q++;
        continue;
      }
      this.graphExtend(out, p.seg, p.dir, rem);
      break;
    }
    // Backward.
    q = tr.pi;
    x = tr.G;
    rem = tr.half;
    for (;;) {
      const p = r[q]!;
      const take = Math.max(0, Math.min(x - p.g0, rem));
      Interlocking.addSpan(out, p, x - take, x);
      rem -= take;
      x -= take;
      if (rem <= EPS) break;
      if (!p.rev && q > 0 && x <= p.g0 + EPS) {
        q--;
        continue;
      }
      this.graphExtend(out, p.seg, -p.dir as Dir, rem);
      break;
    }
    return out.filter((iv) => !this.isYard(iv.seg));
  }

  /** Another train fouling the junction (within foulingM of it on any of its segments), if any. */
  private foulerOf(node: string, tr: Train): Train | undefined {
    const F = this.F;
    for (const e of this.incident.get(node) ?? []) {
      const len = this.g.segment(e.seg).length;
      for (const o of this.occupancy.get(e.seg) ?? [])
        if (o.tr !== tr && (e.end === 0 ? o.lo < F : o.hi > len - F))
          return o.tr;
    }
    return undefined;
  }

  private fouled(node: string, tr: Train): boolean {
    return this.foulerOf(node, tr) !== undefined;
  }

  // --- section reservations ---

  private covered(tr: Train, p: RoutePiece): boolean {
    return tr.res.some(
      (r) =>
        r.seg === p.seg
        && r.dir === p.dir
        && r.g0 <= p.g0 + EPS
        && r.g1 >= p.g1 - EPS,
    );
  }

  private nodeAt(p: RoutePiece, atEnd: boolean): string {
    const sg = this.g.segment(p.seg);
    return (p.dir === 1) === atEnd ? sg.to : sg.from;
  }

  /** Reserve the section starting at route piece q, or say why not. */
  private requestSection(tr: Train, q: number): Refusal | undefined {
    const F = this.F;
    const r = tr.m.route;
    const want: (Omit<Reservation, "tr"> & { piece: RoutePiece })[] = [];
    let endsAtBerth = false;
    let end = r[q]!.g0;
    for (let j = q; j < r.length; j++) {
      const p = r[j]!;
      if (j > q && p.rev) break;
      if (!this.needsReservation(p)) break;
      const nx = r[j + 1];
      const excl = Boolean(nx?.rev) || !nx;
      if (!this.covered(tr, p) || excl)
        want.push({
          seg: p.seg,
          dir: p.dir,
          excl,
          g0: p.g0,
          g1: p.g1,
          piece: p,
        });
      end = p.g1;
      if (excl) {
        endsAtBerth = true;
        break;
      }
    }
    // Nor while another train fouls a junction at either end of it or inside it.
    let routeNodes: [string, number][] = [];
    if (want.length) {
      const nodes = new Map<string, number>();
      for (let j = q; j < r.length && r[j]!.g0 < end - EPS; j++) {
        if (j > q && r[j]!.rev) break;
        if (!nodes.has(this.nodeAt(r[j]!, false)))
          nodes.set(this.nodeAt(r[j]!, false), r[j]!.g0);
        nodes.set(this.nodeAt(r[j]!, true), r[j]!.g1);
      }
      for (const [node] of nodes) {
        if (!this.lockable(node)) continue;
        const f = this.foulerOf(node, tr);
        if (
          f
          && !want.some((w) =>
            (this.reservations.get(w.seg) ?? []).some((x) => x.tr === f),
          )
        )
          return { why: "track occupied", by: f };
        // Nor through a junction another train has set its route over and can no longer stop short
        // of (one that still can stops for this reservation instead, and gives the junction back).
        const holder = this.nodeLocks.get(node);
        if (
          holder
          && holder !== tr
          && this.committedTo(holder, node)
          && !want.some((w) =>
            (this.reservations.get(w.seg) ?? []).some((x) => x.tr === holder),
          )
        )
          return { why: "junction", by: holder };
      }
      routeNodes = [...nodes].filter(
        ([node, x]) => this.lockable(node) && x > tr.G - tr.half,
      );
    }
    // Don't enter a section without room to clear it at the far end (else the train stands in it,
    // blocking opposing trains, while it queues behind the train ahead).
    if (!endsAtBerth) {
      const by = this.clearBeyond(tr, end, 2 * tr.half + this.margin);
      if (by) return { why: "no room beyond the section", by };
    }
    // Time to clear the whole section from a standstill (conservative), for crossing moves.
    const clearAt =
      this.now
      + minLegTime(Math.max(0, end - (tr.G + tr.half)) + 2 * tr.half, tr.kin)
      + this.cfg.crossingBufferS;
    for (const w of want) {
      for (const o of this.reservations.get(w.seg) ?? []) {
        if (o.tr === tr) continue;
        if (o.excl || w.excl)
          return { why: "berth or stub track occupied", by: o.tr };
        if (
          o.dir !== w.dir
          && !(endsAtBerth === false && this.earliestArrival(o) >= clearAt)
        )
          return { why: "opposing train on single track", by: o.tr };
      }
      // Another train on the part of the segment this train will run over (not elsewhere on it).
      const lo = Math.min(w.piece.from, w.piece.to);
      const hi = Math.max(w.piece.from, w.piece.to);
      for (const o of this.occupancy.get(w.seg) ?? []) {
        if (o.tr === tr || o.hi <= lo || o.lo >= hi) continue;
        if (!(this.reservations.get(w.seg) ?? []).some((x) => x.tr === o.tr))
          return { why: "track occupied", by: o.tr };
      }
    }
    for (const { piece: _, ...w } of want) {
      const res = { ...w, tr };
      tr.res.push(res);
      (
        this.reservations.get(w.seg)
        ?? this.reservations.set(w.seg, []).get(w.seg)!
      ).push(res);
    }
    // The section's junctions: others may pass through them (they check there's room to clear)
    // but not stop on them before this train has passed.
    for (const [node, x] of routeNodes) {
      if (!this.routeHolder.has(node)) this.routeHolder.set(node, tr);
      tr.routeNodes.push({ node, releaseG: x + F + tr.half });
    }
    return undefined;
  }

  /** Whether a train holding a junction lock can no longer stop clear of the junction. */
  private committedTo(h: Train, node: string): boolean {
    const l = h.locks.find((x) => x.node === node);
    if (!l) return true;
    const it = h.m.items[h.i];
    const k = it?.k === "move" ? kinOf(h, it) : h.kin;
    return h.G + stopDist(h.v, k) > l.x - this.F - CLEAR_M - h.half + EPS;
  }

  /** The soonest a reservation's holder could reach it: remaining dwell, then line speed all the way. */
  private earliestArrival(o: Reservation): number {
    const h = o.tr;
    const dist = o.g0 - (h.G + h.half);
    if (dist <= 0) return -Infinity;
    const it = h.m.items[h.i];
    const wait =
      it?.k === "wait" ?
        Math.max(0, Math.max(it.until, h.itemStart + it.minDur) - this.now)
      : it?.k === "move" && Number.isNaN(h.itemStart) ?
        Math.max(0, it.notBefore - this.now)
      : 0;
    return this.now + wait + dist / (h.kin.maxSpeed / 3.6);
  }

  /** Give back what the train has passed (its rear is clear of), or everything it holds. */
  release(tr: Train, all = false): void {
    const tail = tr.G - tr.half;
    tr.res = tr.res.filter((r) => {
      if (!all && r.g1 >= tail) return true;
      const list = this.reservations.get(r.seg)!;
      list.splice(list.indexOf(r), 1);
      return false;
    });
    tr.locks = tr.locks.filter((l) => {
      if (!all && l.releaseG >= tr.G) return true;
      if (this.nodeLocks.get(l.node) === tr) this.nodeLocks.delete(l.node);
      return false;
    });
    tr.routeNodes = tr.routeNodes.filter((l) => {
      if (!all && l.releaseG >= tr.G) return true;
      if (this.routeHolder.get(l.node) === tr) this.routeHolder.delete(l.node);
      return false;
    });
  }

  /** The first train on the train's route from x for `dist` metres (up to its next reversal), if any. */
  private clearBeyond(tr: Train, x: number, dist: number): Train | undefined {
    if (dist <= 0) return undefined;
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
      for (const o of this.occupancy.get(p.seg) ?? []) {
        // Occupancy intervals always have their train (occupy()).
        if (o.tr !== tr && o.lo < hi - EPS && lo + EPS < o.hi) return o.tr!;
      }
    }
    return undefined;
  }

  // --- movement authority ---

  private blockAt(at: number, reason: string, who?: Train): void {
    const A = this.A;
    if (at < A.lim) {
      A.lim = at;
      A.why = reason;
      A.by = who;
    }
  }

  private reachable(stopAt: number): boolean {
    return this.A.lim >= stopAt - EPS;
  }

  /**
   * How far (route coordinate of the train's centre) the train may go during the current move.
   * Acquires junction locks and section reservations it needs within `need` metres of its head.
   */
  authority(tr: Train, item: MoveItem, need: number): Authority {
    if (tr.G < tr.forcedTo) return { lim: Infinity, why: "" };
    const { g, F, margin, A } = this;
    const dt = this.cfg.stepS;
    const r = tr.m.route;
    const head = tr.G + tr.half;
    const k = kinOf(tr, item);
    const vmax = k.maxSpeed / 3.6;
    const scan =
      (vmax * vmax) / (2 * k.decel)
      + vmax * dt
      + margin
      + tr.half
      + F
      + LOOKAHEAD_SLACK_M;
    A.lim = Infinity;
    A.why = "";
    A.by = undefined;
    pieceAt(tr);
    const tracing =
      this.trace?.run === tr.m.run.id
      && this.now >= this.trace.from
      && this.now <= this.trace.to;
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
      if (tracing)
        console.log(
          `  [auth ${this.now}] q=${q} ${p.seg}${p.dir > 0 ? "+" : "-"} g0=${p.g0.toFixed(1)} head=${head.toFixed(1)} need=${need.toFixed(1)} needsRes=${this.needsReservation(p)} covered=${this.covered(tr, p)} A.lim=${A.lim.toFixed(1)} stopAt=${stopAt.toFixed(1)} beyond=${beyondStop}`,
        );
      if (!beyondStop && p.g1 > tail + EPS && !this.covered(tr, p)) {
        if (this.needsReservation(p)) {
          // Never enter a section you can't leave: reserve it through to where it ends or reverses.
          if (p.g0 - head <= need + F && this.reachable(stopAt)) {
            const refused = this.requestSection(tr, q);
            if (refused) this.blockAt(stopAt, refused.why, refused.by);
          } else if (!inside) this.blockAt(stopAt, "section ahead");
        } else {
          // Someone running against traffic here holds it.
          for (const o of this.reservations.get(p.seg) ?? []) {
            if (o.tr !== tr && (o.dir !== p.dir || o.excl)) {
              this.blockAt(stopAt, "opposing move", o.tr);
              break;
            }
          }
        }
      }
      // Moving block: other trains on this piece of my path.
      for (const o of this.occupancy.get(p.seg) ?? []) {
        if (o.tr === tr) continue;
        const lo = Math.max(Math.min(p.from, p.to), o.lo);
        const hi = Math.min(Math.max(p.from, p.to), o.hi);
        if (hi - lo <= EPS) continue;
        const xa = p.g0 + (lo - p.from) * p.dir;
        const xb = p.g0 + (hi - p.from) * p.dir;
        const near = Math.min(xa, xb);
        const far = Math.max(xa, xb);
        if (far <= head + EPS) continue;
        this.blockAt(
          near < head ? tr.G : near - margin - tr.half,
          "train ahead",
          o.tr,
        );
      }
      if (A.lim < p.g0) break;
      // Junction at the end of this piece.
      const nx = r[q + 1];
      if (nx && !nx.rev && nx.seg !== p.seg) {
        const node = p.dir === 1 ? g.segment(p.seg).to : g.segment(p.seg).from;
        const x = p.g1;
        const at = x - F - CLEAR_M - tr.half;
        if (
          x > tr.G
          && x < item.g1 + tr.half - EPS
          && x - head <= need + F
          && this.lockable(node)
          && this.nodeLocks.get(node) !== tr
        ) {
          if (!this.reachable(at)) break;
          // Reserve the section beyond the junction first, so a refusal doesn't leave the junction locked.
          if (this.needsReservation(nx) && !this.covered(tr, nx)) {
            const refused = this.requestSection(tr, q + 1);
            if (refused) {
              this.blockAt(at, refused.why, refused.by);
              break;
            }
          }
          if (this.nodeLocks.has(node) || this.fouled(node, tr)) {
            this.blockAt(
              at,
              "junction",
              this.nodeLocks.get(node) ?? this.foulerOf(node, tr),
            );
            break;
          }
          // Stopping on a junction another train's section runs through would trap that train.
          const rh = this.routeHolder.get(node);
          if (rh && rh !== tr && x > item.g1 - tr.half - F - EPS) {
            this.blockAt(at, "junction (route set for another train)", rh);
            break;
          }
          // Only set a route through a junction the train can clear (unless it stops on it by plan).
          const by = this.clearBeyond(
            tr,
            x,
            Math.min(F + 2 * tr.half + margin, item.g1 + tr.half - x),
          );
          if (by) {
            this.blockAt(at, "junction (no room beyond)", by);
            break;
          }
          this.nodeLocks.set(node, tr);
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
        const rh = this.routeHolder.get(node);
        if (rh && rh !== tr && x - F - tr.half < A.lim) {
          this.blockAt(
            Math.max(tr.G, x - F - CLEAR_M - tr.half),
            "junction (route set for another train)",
            rh,
          );
          break;
        }
      }
    }
    // Give back junctions beyond where the train must now stop: it can't use them yet, and holding
    // them could block the very train it waits for.
    if (A.lim < Infinity) {
      tr.locks = tr.locks.filter((l) => {
        if (l.x - F <= A.lim + tr.half + EPS || l.x <= head) return true;
        if (this.nodeLocks.get(l.node) === tr) this.nodeLocks.delete(l.node);
        return false;
      });
    }
    return A.by ?
        { lim: A.lim, why: A.why, by: A.by }
      : { lim: A.lim, why: A.why };
  }

  /** A train appears (leaves the yard, or is found at its first platform) only where that's free. */
  canSpawn(tr: Train): boolean {
    const F = this.F;
    const body = this.bodyOf(tr);
    for (const iv of body) {
      for (const o of this.occupancy.get(iv.seg) ?? [])
        if (o.tr !== tr && o.lo < iv.hi && iv.lo < o.hi) return false;
      if ((this.reservations.get(iv.seg) ?? []).some((o) => o.tr !== tr))
        return false;
      // Nor may it appear fouling a junction another train is using or about to use.
      const sg = this.g.segment(iv.seg);
      for (const [node, near] of [
        [sg.from, iv.lo < F] as const,
        [sg.to, iv.hi > sg.length - F] as const,
      ]) {
        if (!near || !this.lockable(node)) continue;
        const holder = this.nodeLocks.get(node) ?? this.routeHolder.get(node);
        if ((holder && holder !== tr) || this.fouled(node, tr)) return false;
      }
    }
    const p = pieceAt(tr);
    if (p && this.needsReservation(p) && !this.covered(tr, p) && body.length)
      return this.requestSection(tr, tr.pi) === undefined;
    return true;
  }
}
