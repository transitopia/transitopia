// In-memory track graph with switch-aware routing (PLAN.md §4.1, §4.4). Shared by build scripts,
// tests and the browser.
//
// Direction: a train on segment s moving with dir = +1 travels from s.from to s.to (increasing
// offset); dir = −1 the opposite way. At a node, a train may continue only onto segment ends paired
// with its exit end in the node's `turns`, so it can't reverse through a switch. Reversal is allowed
// only where configured: at dead ends, inside pocket/tail/siding tracks, or explicitly at the start
// or target (e.g. a stub-ended terminus platform).

import { bearingDeg as bearingOf, cumulativeLengths, distM, localProjector, pointAlong, projectOnto, type LonLat } from '../geo.ts';
import type { InfraCollection, NodeProps, Segment, SegmentEnd, SegmentKind, StopPosition, TrackNode } from './types.ts';

export type Dir = 1 | -1;

export interface TrackPos {
  seg: string;
  offset: number;
}

/** One traversal of part of a segment: from offset → to offset (to < from when dir = −1). */
export interface PathPiece {
  seg: string;
  from: number;
  to: number;
}

export interface Path {
  pieces: PathPiece[];
  length: number;
  reversals: number;
  /** Direction on the final segment. */
  endDir: Dir;
  startDir: Dir;
}

export interface RouteOptions {
  /** Required initial direction; undefined = either. */
  fromDir?: Dir;
  /** Required final direction; undefined = either. */
  toDir?: Dir;
  /** Permit reversing at dead ends and inside reversal tracks along the way. */
  allowReversals?: boolean;
  /** Permit reversing in place at the start position (e.g. stub terminus) — costs a penalty. */
  allowReverseAtStart?: boolean;
  /** Permit arriving facing the wrong way and reversing at the target — costs a penalty. */
  allowReverseAtTarget?: boolean;
  /** Distance-equivalent cost of one reversal (m). */
  reversalPenalty?: number;
  /** How far into a pocket/tail a train runs before reversing (m): ≥ train length. */
  reversalRunIn?: number;
  /** Segment kinds the route may use (default: all but yard). */
  kinds?: Set<SegmentKind>;
  /** Extra distance-equivalent cost for entering a segment of these kinds (m), e.g. to keep revenue running on main track. */
  kindPenalty?: Partial<Record<SegmentKind, number>>;
  /** Give up beyond this distance (m). */
  maxLength?: number;
  /** With a null target: finish on entering any segment of these kinds (e.g. reach a yard). */
  goalKinds?: Set<SegmentKind>;
  /**
   * Also allow reversing on main track just past a switch (run in, stop, reverse back through it) —
   * how trains short-turn at through stations without a pocket. Costs `mainReversalPenalty`.
   */
  allowMainReversals?: boolean;
  mainReversalPenalty?: number;
}

const REVERSAL_KINDS = new Set<SegmentKind>(['pocket', 'tail', 'siding']);
const DEFAULT_KINDS = new Set<SegmentKind>(['main', 'pocket', 'tail', 'siding', 'crossover', 'spur']);

interface Transition {
  seg: string;
  dir: Dir;
}

export class TrackGraph {
  readonly segments = new Map<string, Segment>();
  readonly nodes = new Map<string, TrackNode>();
  readonly stops: StopPosition[] = [];
  /** `${segEnd}` → segment ends it connects to. */
  private turns = new Map<SegmentEnd, SegmentEnd[]>();

  static fromCollection(fc: InfraCollection): TrackGraph {
    const g = new TrackGraph();
    for (const f of fc.features) {
      const p = f.properties;
      if (p.type === 'segment') {
        const coords = (f.geometry as GeoJSON.LineString).coordinates as LonLat[];
        const { type: _t, ...rest } = p;
        g.segments.set(p.id, { ...rest, coords, cum: cumulativeLengths(coords) });
      } else if (p.type === 'node') {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as LonLat;
        const { type: _t, ...rest } = p as NodeProps;
        g.nodes.set(p.id, { ...rest, lon, lat });
        for (const [a, b] of p.turns) {
          (g.turns.get(a) ?? g.turns.set(a, []).get(a)!).push(b);
          (g.turns.get(b) ?? g.turns.set(b, []).get(b)!).push(a);
        }
      } else if (p.type === 'stop') {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as LonLat;
        const { type: _t, ...rest } = p;
        g.stops.push({ ...rest, lon, lat });
      }
    }
    return g;
  }

  /** Allow or forbid passing between two segments at a node (overrides; see overrides.json). */
  setTurn(node: LonLat, a: LonLat, b: LonLat, allow: boolean): void {
    let nd: TrackNode | undefined;
    let nd2 = 5;
    for (const n of this.nodes.values()) {
      const d = distM([n.lon, n.lat], node);
      if (d < nd2) {
        nd2 = d;
        nd = n;
      }
    }
    if (!nd) throw new Error(`Turn override: no node within 5 m of ${node}`);
    const ends: { end: SegmentEnd; seg: Segment }[] = [];
    for (const s of this.segments.values()) {
      if (s.from === nd.id) ends.push({ end: `${s.id}:0`, seg: s });
      if (s.to === nd.id) ends.push({ end: `${s.id}:1`, seg: s });
    }
    const nearestEnd = (p: LonLat) => {
      let best: SegmentEnd | undefined;
      let bd = Infinity;
      for (const e of ends) {
        const d = projectOnto(e.seg.coords, e.seg.cum, p, 0, 0).offset;
        if (d < bd) {
          bd = d;
          best = e.end;
        }
      }
      if (!best) throw new Error(`Turn override: node ${nd.id} has no segments`);
      return best;
    };
    const ea = nearestEnd(a);
    const eb = nearestEnd(b);
    const link = (x: SegmentEnd, y: SegmentEnd) => {
      const list = this.turns.get(x) ?? [];
      const has = list.includes(y);
      if (allow && !has) list.push(y);
      if (!allow && has) list.splice(list.indexOf(y), 1);
      this.turns.set(x, list);
    };
    link(ea, eb);
    link(eb, ea);
    const turns = (nd.turns = nd.turns.filter(([x, y]) => !((x === ea && y === eb) || (x === eb && y === ea))));
    if (allow) turns.push([ea, eb]);
  }

  segment(id: string): Segment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`Unknown segment ${id}`);
    return s;
  }

  /** Where a train moving along `seg` in `dir` can go at the segment's exit node. */
  successors(seg: string, dir: Dir): Transition[] {
    const exit: SegmentEnd = `${seg}:${dir === 1 ? 1 : 0}`;
    return (this.turns.get(exit) ?? []).map((end) => {
      const i = end.lastIndexOf(':');
      return { seg: end.slice(0, i), dir: end.slice(i + 1) === '0' ? 1 : -1 };
    });
  }

  /** True if the exit node in this direction has no onward track (end of line / buffer). */
  isDeadEnd(seg: string, dir: Dir): boolean {
    return this.successors(seg, dir).length === 0;
  }

  pointAt(pos: TrackPos, dir: Dir = 1): { lon: number; lat: number; bearing: number } {
    const s = this.segment(pos.seg);
    const p = pointAlong(s.coords, s.cum, pos.offset);
    return { lon: p.lon, lat: p.lat, bearing: dir === 1 ? p.bearing : (p.bearing + 180) % 360 };
  }

  /**
   * Points along the track from `pos` for `dist` metres in `dir`, following the straightest
   * continuation at switches (for drawing trains along curves). Stops early at dead ends.
   */
  walk(pos: TrackPos, dir: Dir, dist: number, step = 8): LonLat[] {
    const out: LonLat[] = [];
    let seg = this.segment(pos.seg);
    let offset = pos.offset;
    let d = dir;
    let remaining = dist;
    const push = () => {
      const p = pointAlong(seg.coords, seg.cum, offset);
      out.push([p.lon, p.lat]);
    };
    push();
    for (let guard = 0; guard < 200 && remaining > 1e-6; guard++) {
      const toEnd = d === 1 ? seg.length - offset : offset;
      const stepLen = Math.min(step, remaining, toEnd);
      if (stepLen > 1e-6) {
        offset += d * stepLen;
        remaining -= stepLen;
        push();
        continue;
      }
      // At the segment end: continue onto the straightest successor.
      const nexts = this.successors(seg.id, d);
      if (!nexts.length) break;
      const here = pointAlong(seg.coords, seg.cum, offset);
      let best = nexts[0]!;
      let bestDiff = Infinity;
      for (const n of nexts) {
        const ns = this.segment(n.seg);
        const p = pointAlong(ns.coords, ns.cum, n.dir === 1 ? Math.min(ns.length, 10) : Math.max(0, ns.length - 10));
        const b = bearingOf([here.lon, here.lat], [p.lon, p.lat]);
        const want = d === 1 ? here.bearing : (here.bearing + 180) % 360;
        const diff = Math.abs(((b - want + 540) % 360) - 180);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = n;
        }
      }
      seg = this.segment(best.seg);
      d = best.dir;
      offset = d === 1 ? 0 : seg.length;
    }
    return out;
  }

  /** Track positions near a point, nearest first. */
  nearest(p: LonLat, maxDist: number, kinds = DEFAULT_KINDS): (TrackPos & { dist: number })[] {
    const proj = localProjector(p[1]);
    const [px, py] = proj.toXY(p);
    const out: (TrackPos & { dist: number })[] = [];
    for (const s of this.segments.values()) {
      if (!kinds.has(s.kind)) continue;
      // Cheap bbox reject.
      let near = false;
      for (const c of s.coords) {
        const [x, y] = proj.toXY(c);
        if (Math.abs(x - px) < maxDist + s.length && Math.abs(y - py) < maxDist + s.length) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      const pr = projectOnto(s.coords, s.cum, p, 0, 0);
      if (pr.offset <= maxDist) out.push({ seg: s.id, offset: pr.along, dist: pr.offset });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /**
   * Shortest legal path between two track positions, or null. With `to` = null and
   * `opts.goalKinds`, the path ends where it first enters a segment of one of those kinds.
   */
  route(from: TrackPos, to: TrackPos | null, opts: RouteOptions = {}): Path | null {
    const penalty = opts.reversalPenalty ?? 400;
    const runIn = opts.reversalRunIn ?? 100;
    const kinds = opts.kinds ?? DEFAULT_KINDS;
    const maxLength = opts.maxLength ?? 60_000;
    const len = (id: string) => this.segment(id).length;

    type Key = string; // `${seg}|${dir}`
    interface Rec {
      cost: number;
      seg: string;
      dir: Dir;
      parent?: Key;
      via: 'start' | 'turn' | 'deadend' | 'pocket';
      startDir?: Dir;
    }
    const best = new Map<Key, Rec>();
    const heap = new MinHeap<Key>();
    let goal: { cost: number; key?: Key; direct?: { dir: Dir }; endDir: Dir; reverseAtTarget: boolean } | undefined;

    const consider = (cost: number, dir: Dir, key: Key | undefined, direct?: { dir: Dir }) => {
      // Arriving on the target segment moving `dir`.
      let c = cost;
      let reverseAtTarget = false;
      if (opts.toDir !== undefined && dir !== opts.toDir) {
        if (!opts.allowReverseAtTarget) return;
        c += penalty;
        reverseAtTarget = true;
      }
      if (!goal || c < goal.cost) goal = { cost: c, key, direct, endDir: reverseAtTarget ? (-dir as Dir) : dir, reverseAtTarget };
    };

    // A goal pseudo-state keeps its cheapest arrival: overwriting it with a costlier one (while the
    // goal kept the cheaper cost) rebuilt paths through the wrong approach, e.g. through Metrotown's
    // centre pocket instead of the main line past it.
    const setGoal = (k: Key, rec: Rec) => {
      const prev = best.get(k);
      if (prev && prev.cost <= rec.cost) return;
      best.set(k, rec);
      consider(rec.cost, rec.dir, k);
    };

    const startDirs: Dir[] = opts.fromDir === undefined ? [1, -1] : opts.allowReverseAtStart ? [opts.fromDir, -opts.fromDir as Dir] : [opts.fromDir];
    for (const d of startDirs) {
      const extra = opts.fromDir !== undefined && d !== opts.fromDir ? penalty : 0;
      // Direct: target ahead on the same segment.
      if (to && from.seg === to.seg && (to.offset - from.offset) * d >= 0) consider(Math.abs(to.offset - from.offset) + extra, d, undefined, { dir: d });
      const toExit = d === 1 ? len(from.seg) - from.offset : from.offset;
      const key = `${from.seg}|${d}`;
      const rec: Rec = { cost: toExit + extra, seg: from.seg, dir: d, via: 'start', startDir: d };
      if (!best.has(key) || best.get(key)!.cost > rec.cost) {
        best.set(key, rec);
        heap.push(rec.cost, key);
      }
    }

    while (heap.size) {
      const [cost, key] = heap.pop()!;
      const rec = best.get(key)!;
      if (cost > rec.cost) continue;
      if (goal && cost >= goal.cost) break;
      if (cost > maxLength) break;
      const push = (seg: string, dir: Dir, c: number, via: Rec['via']) => {
        const k = `${seg}|${dir}`;
        const prev = best.get(k);
        if (prev && prev.cost <= c) return;
        best.set(k, { cost: c, seg, dir, parent: key, via });
        heap.push(c, k);
      };
      const nexts = this.successors(rec.seg, rec.dir);
      for (const t of nexts) {
        const ts = this.segments.get(t.seg);
        if (!ts) continue;
        if (!to && opts.goalKinds?.has(ts.kind)) {
          // Reached a goal-kind segment: finish at its entry.
          const k = `${t.seg}|${t.dir}|goal`;
          setGoal(k, { cost, seg: t.seg, dir: t.dir, parent: key, via: 'turn' });
          continue;
        }
        if (!kinds.has(ts.kind)) continue;
        const kp = opts.kindPenalty?.[ts.kind] ?? 0;
        // Entering the target segment: finish partway along it.
        if (to && t.seg === to.seg) {
          const partial = t.dir === 1 ? to.offset : ts.length - to.offset;
          // Record a pseudo-state for reconstruction.
          setGoal(`${t.seg}|${t.dir}|goal`, { cost: cost + kp + partial, seg: t.seg, dir: t.dir, parent: key, via: 'turn' });
        }
        push(t.seg, t.dir, cost + kp + ts.length, 'turn');
        // Run into a reversal track (or, if allowed, onto main track past a switch), reverse, come back out.
        const mainRev = opts.allowMainReversals && ts.kind === 'main' && nexts.length > 1;
        if (opts.allowReversals && (REVERSAL_KINDS.has(ts.kind) || mainRev)) {
          const x = Math.min(ts.length, runIn);
          push(t.seg, -t.dir as Dir, cost + 2 * x + (mainRev ? (opts.mainReversalPenalty ?? 1500) : penalty), 'pocket');
        }
      }
      if (opts.allowReversals && nexts.length === 0) push(rec.seg, -rec.dir as Dir, cost + penalty + len(rec.seg), 'deadend');
    }

    if (!goal) return null;
    const g = goal as { cost: number; key?: Key; direct?: { dir: Dir }; endDir: Dir; reverseAtTarget: boolean };
    if (g.direct && to) {
      const reversals = (opts.fromDir !== undefined && g.direct.dir !== opts.fromDir ? 1 : 0) + (g.reverseAtTarget ? 1 : 0);
      return {
        pieces: [{ seg: from.seg, from: from.offset, to: to.offset }],
        length: Math.abs(to.offset - from.offset),
        reversals,
        endDir: g.endDir,
        startDir: g.direct.dir,
      };
    }
    // Reconstruct.
    const chain: Rec[] = [];
    for (let k: Key | undefined = g.key; k; k = best.get(k)!.parent) chain.push(best.get(k)!);
    chain.reverse();
    const pieces: PathPiece[] = [];
    let reversals = g.reverseAtTarget ? 1 : 0;
    const first = chain[0]!;
    if (opts.fromDir !== undefined && first.startDir !== opts.fromDir) reversals++;
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i]!;
      const L = len(r.seg);
      const isLast = i === chain.length - 1;
      if (r.via === 'start') {
        pieces.push({ seg: r.seg, from: from.offset, to: r.dir === 1 ? L : 0 });
      } else if (r.via === 'turn') {
        const entry = r.dir === 1 ? 0 : L;
        // A goal-kind finish ends at the segment's entry.
        const end = isLast ? (to ? to.offset : entry) : r.dir === 1 ? L : 0;
        pieces.push({ seg: r.seg, from: entry, to: end });
      } else if (r.via === 'deadend') {
        reversals++;
        pieces.push({ seg: r.seg, from: r.dir === 1 ? 0 : L, to: r.dir === 1 ? L : 0 });
      } else {
        // Pocket: entered through the end that is the exit for r.dir, ran in x, reversed, back out.
        reversals++;
        const x = Math.min(L, runIn);
        const exitEnd = r.dir === 1 ? L : 0;
        const turnPoint = r.dir === 1 ? L - x : x;
        pieces.push({ seg: r.seg, from: exitEnd, to: turnPoint }, { seg: r.seg, from: turnPoint, to: exitEnd });
      }
    }
    const length = pieces.reduce((s, p) => s + Math.abs(p.to - p.from), 0);
    return { pieces, length, reversals, endDir: g.endDir, startDir: first.startDir ?? first.dir };
  }
}

/** Minimal binary heap keyed by numeric priority. */
class MinHeap<T> {
  private items: [number, T][] = [];
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T): void {
    const a = this.items;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j]![0] <= a[i]![0]) break;
      [a[i], a[j]] = [a[j]!, a[i]!];
      i = j;
    }
  }
  pop(): [number, T] | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}
