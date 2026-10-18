// Matching bus shapes to OSM roads (packages/transit-core/DESIGN.md#bus-corridors). GTFS shapes are
// coarse: they cut corners, chord across loops and jog toward stops. A hidden Markov model over
// shape samples (candidates: nearby directed road edges; transitions: route length on the road graph
// vs straight distance) picks the roads the bus most likely drove. Stretches with no plausible road
// keep the GTFS geometry. Used at build time only.

import { localProjector, type LonLat } from "../geo.ts";

/** Overpass JSON elements (`out body` ways, `out skel` nodes). */
export interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

/** Shape samples are this far apart (m). */
const SAMPLE_M = 25;
/** Road edges this close to a sample are candidates (m)… */
const CANDIDATE_M = 30;
/** …or this close, when nothing is within CANDIDATE_M (m). */
const CANDIDATE_FAR_M = 55;
const MAX_CANDIDATES = 8;
/** Where no candidates connect, the candidates of up to this many samples back grow. */
const WIDEN_SAMPLES = 24;
/** A step back along an edge this short is standing still (m). */
const STILL_M = 1;
/** GPS-style emission noise: how far GTFS shapes typically sit from the road centreline (m). */
const SIGMA_M = 10;
/** Transition scale: how much longer than the straight line a route between samples may be (m). */
const BETA_M = 12;
/** Searching for a route between samples gives up beyond this many times the straight distance, plus SEARCH_SLACK_M. */
const SEARCH_FACTOR = 3;
const SEARCH_SLACK_M = 120;
/** Spatial index cell (m). */
const CELL_M = 50;

/** Cost per metre by road class: buses keep to through roads unless the shape says otherwise. */
const CLASS_COST: Record<string, number> = {
  busway: 0.9,
  bus_guideway: 0.9,
  service: 1.4,
  residential: 1.1,
  living_street: 1.2,
  unclassified: 1.05,
};

/**
 * Extra cost factor for roads buses may not be meant to use. Closed to traffic but not tagged for
 * buses is often a bus loop tagged incompletely (Coquitlam Central's), so such roads stay in the
 * graph at a higher cost and the shape decides; so do parking aisles and drive-throughs.
 */
function accessCost(tags: Record<string, string>): number {
  const yes = (v: string | undefined) => v === "yes" || v === "designated";
  if (yes(tags["bus"]) || yes(tags["psv"])) return 1;
  const access = tags["motor_vehicle"] ?? tags["access"];
  if (access === "no" || access === "private") return 1.6;
  const service = tags["service"];
  if (service === "parking_aisle" || service === "driveway") return 1.8;
  if (service === "drive-through") return 3;
  return 1;
}

/** +1: forward only; -1: backward only; 0: both ways (for buses). */
function onewayOf(tags: Record<string, string>): -1 | 0 | 1 {
  const busOk = (v: string | undefined) => v === "no";
  if (busOk(tags["oneway:bus"]) || busOk(tags["oneway:psv"])) return 0;
  const o = tags["oneway"];
  if (o === "-1" || o === "reverse") return -1;
  if (o === "yes" || o === "true" || o === "1") return 1;
  if (o === "no") return 0;
  if (tags["junction"] === "roundabout" || tags["junction"] === "circular")
    return 1;
  if (tags["highway"] === "motorway") return 1;
  return 0;
}

/** Directed road graph in a local metric projection, with a grid index over its edges. */
export class RoadGraph {
  readonly nodeId: number[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLen: Float64Array;
  readonly edgeCost: Float64Array;
  /** The edge running the other way along the same road, or -1. */
  readonly edgeTwin: Int32Array;
  readonly outStart: Int32Array;
  readonly outEdges: Int32Array;
  private readonly grid = new Map<number, number[]>();
  private readonly proj: ReturnType<typeof localProjector>;

  private constructor(
    proj: ReturnType<typeof localProjector>,
    nodeId: number[],
    x: number[],
    y: number[],
    edges: { from: number; to: number; cost: number; twin: number }[],
  ) {
    this.proj = proj;
    this.nodeId = nodeId;
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    const n = edges.length;
    this.edgeFrom = new Int32Array(n);
    this.edgeTo = new Int32Array(n);
    this.edgeLen = new Float64Array(n);
    this.edgeCost = new Float64Array(n);
    this.edgeTwin = new Int32Array(n);
    const deg = new Int32Array(nodeId.length + 1);
    edges.forEach((e, i) => {
      this.edgeFrom[i] = e.from;
      this.edgeTo[i] = e.to;
      const len = Math.hypot(x[e.to]! - x[e.from]!, y[e.to]! - y[e.from]!);
      this.edgeLen[i] = len;
      this.edgeCost[i] = len * e.cost;
      this.edgeTwin[i] = e.twin;
      deg[e.from + 1]!++;
    });
    for (let i = 0; i < nodeId.length; i++) deg[i + 1]! += deg[i]!;
    this.outStart = deg;
    this.outEdges = new Int32Array(n);
    const fill = deg.slice(0, nodeId.length);
    for (let i = 0; i < n; i++) this.outEdges[fill[this.edgeFrom[i]!]!++] = i;
    // Index each road once (an edge and its twin share geometry).
    for (let i = 0; i < n; i++) {
      if (this.edgeTwin[i]! >= 0 && this.edgeTwin[i]! < i) continue;
      const a = this.edgeFrom[i]!;
      const b = this.edgeTo[i]!;
      const steps = Math.max(1, Math.ceil(this.edgeLen[i]! / CELL_M));
      const seen = new Set<number>();
      for (let k = 0; k <= steps; k++) {
        const px = this.x[a]! + ((this.x[b]! - this.x[a]!) * k) / steps;
        const py = this.y[a]! + ((this.y[b]! - this.y[a]!) * k) / steps;
        const c = this.cell(px, py);
        if (seen.has(c)) continue;
        seen.add(c);
        let list = this.grid.get(c);
        if (!list) this.grid.set(c, (list = []));
        list.push(i);
      }
    }
  }

  private cell(px: number, py: number): number {
    return Math.floor(px / CELL_M) * 1_000_003 + Math.floor(py / CELL_M);
  }

  static fromOsm(elements: OsmElement[]): RoadGraph {
    const coords = new Map<number, LonLat>();
    for (const e of elements)
      if (e.type === "node" && e.lon !== undefined && e.lat !== undefined)
        coords.set(e.id, [e.lon, e.lat]);
    let latSum = 0;
    for (const c of coords.values()) latSum += c[1];
    const proj = localProjector(coords.size ? latSum / coords.size : 49);
    const index = new Map<number, number>();
    const nodeId: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    const nodeOf = (id: number): number | undefined => {
      let i = index.get(id);
      if (i !== undefined) return i;
      const c = coords.get(id);
      if (!c) return undefined;
      i = nodeId.length;
      index.set(id, i);
      nodeId.push(id);
      const [px, py] = proj.toXY(c);
      x.push(px);
      y.push(py);
      return i;
    };
    const edges: { from: number; to: number; cost: number; twin: number }[] =
      [];
    for (const w of elements) {
      if (w.type !== "way" || !w.nodes || !w.tags?.["highway"]) continue;
      const cost = (CLASS_COST[w.tags["highway"]] ?? 1) * accessCost(w.tags);
      const oneway = onewayOf(w.tags);
      for (let k = 0; k + 1 < w.nodes.length; k++) {
        const a = nodeOf(w.nodes[k]!);
        const b = nodeOf(w.nodes[k + 1]!);
        if (a === undefined || b === undefined || a === b) continue;
        const fwd = oneway >= 0 ? edges.length : -1;
        if (oneway >= 0) edges.push({ from: a, to: b, cost, twin: -1 });
        if (oneway <= 0) {
          edges.push({ from: b, to: a, cost, twin: fwd });
          if (fwd >= 0) edges[fwd]!.twin = edges.length - 1;
        }
      }
    }
    return new RoadGraph(proj, nodeId, x, y, edges);
  }

  get edgeCount(): number {
    return this.edgeFrom.length;
  }

  toXY(p: LonLat): [number, number] {
    return this.proj.toXY(p);
  }

  toLonLat(px: number, py: number): LonLat {
    return this.proj.toLonLat(px, py);
  }

  /** Point at fraction f along edge e (metric). */
  at(e: number, f: number): [number, number] {
    const a = this.edgeFrom[e]!;
    const b = this.edgeTo[e]!;
    return [
      this.x[a]! + (this.x[b]! - this.x[a]!) * f,
      this.y[a]! + (this.y[b]! - this.y[a]!) * f,
    ];
  }

  /** Directed edges within r of a point, nearest first, with the projection fraction and distance. */
  near(
    px: number,
    py: number,
    r: number,
  ): { e: number; f: number; d: number }[] {
    const out: { e: number; f: number; d: number }[] = [];
    const cx = Math.floor(px / CELL_M);
    const cy = Math.floor(py / CELL_M);
    const span = Math.ceil(r / CELL_M);
    const seen = new Set<number>();
    for (let i = cx - span; i <= cx + span; i++)
      for (let j = cy - span; j <= cy + span; j++)
        for (const e of this.grid.get(i * 1_000_003 + j) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const a = this.edgeFrom[e]!;
          const b = this.edgeTo[e]!;
          const dx = this.x[b]! - this.x[a]!;
          const dy = this.y[b]! - this.y[a]!;
          const l2 = dx * dx + dy * dy;
          const f =
            l2 > 0 ?
              Math.min(
                1,
                Math.max(
                  0,
                  ((px - this.x[a]!) * dx + (py - this.y[a]!) * dy) / l2,
                ),
              )
            : 0;
          const d = Math.hypot(
            this.x[a]! + dx * f - px,
            this.y[a]! + dy * f - py,
          );
          if (d > r) continue;
          out.push({ e, f, d });
          const t = this.edgeTwin[e]!;
          if (t >= 0) out.push({ e: t, f: 1 - f, d });
        }
    out.sort((p, q) => p.d - q.d);
    return out;
  }

  /**
   * Cheapest routes from node `from` to each of `targets`, searching up to `maxCost`: cost and
   * length per reached target, and the predecessor edges to rebuild a path.
   */
  search(
    from: number,
    targets: Set<number>,
    maxCost: number,
  ): {
    cost: Map<number, number>;
    len: Map<number, number>;
    pred: Map<number, number>;
  } {
    const cost = new Map<number, number>([[from, 0]]);
    const len = new Map<number, number>([[from, 0]]);
    const pred = new Map<number, number>();
    const heap = new MinHeap();
    heap.push(0, from);
    let left = targets.size - (targets.has(from) ? 1 : 0);
    const done = new Set<number>();
    while (heap.size && left > 0) {
      const [c, v] = heap.pop();
      if (done.has(v)) continue;
      done.add(v);
      if (v !== from && targets.has(v)) left--;
      for (let k = this.outStart[v]!; k < this.outStart[v + 1]!; k++) {
        const e = this.outEdges[k]!;
        const w = this.edgeTo[e]!;
        const nc = c + this.edgeCost[e]!;
        if (nc > maxCost || nc >= (cost.get(w) ?? Infinity)) continue;
        cost.set(w, nc);
        len.set(w, len.get(v)! + this.edgeLen[e]!);
        pred.set(w, e);
        heap.push(nc, w);
      }
    }
    return { cost, len, pred };
  }
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(k: number, v: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0]!, vals[0]!];
    const k = keys.pop()!;
    const v = vals.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = k;
        if (l < keys.length && keys[l]! < mk) {
          m = l;
          mk = keys[l]!;
        }
        if (r < keys.length && keys[r]! < mk) m = r;
        if (m === i) break;
        keys[i] = keys[m]!;
        vals[i] = vals[m]!;
        i = m;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

/** A piece of a matched shape: part of a directed road edge (fractions f0 → f1), or GTFS geometry kept as is. */
export type MatchPiece =
  { edge: number; f0: number; f1: number } | { raw: LonLat[] };

export interface MatchResult {
  coords: LonLat[];
  pieces: MatchPiece[];
  /** Share of the shape's samples matched to roads. */
  matched: number;
}

interface Candidate {
  e: number;
  f: number;
  d: number;
}

function densify(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++)
      out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/**
 * Whether b is along the same edge from a, or as good as on it: GTFS shapes repeat points, and the
 * repeat can project a few centimetres behind, which would otherwise take a U-turn to reach.
 */
function aheadOnEdge(g: RoadGraph, a: Candidate, b: Candidate): boolean {
  return a.e === b.e && (b.f - a.f) * g.edgeLen[a.e]! >= -STILL_M;
}

/**
 * Route between two candidates: its cost and length along the roads, or undefined beyond the
 * search bound. Moving backwards along one edge isn't allowed (that would need a U-turn).
 */
function routeBetween(
  g: RoadGraph,
  a: Candidate,
  b: Candidate,
  found: ReturnType<RoadGraph["search"]>,
): { cost: number; len: number } | undefined {
  if (aheadOnEdge(g, a, b)) {
    const len = Math.max(0, (b.f - a.f) * g.edgeLen[a.e]!);
    return { cost: (len * g.edgeCost[a.e]!) / (g.edgeLen[a.e]! || 1), len };
  }
  const via = g.edgeFrom[b.e]!;
  const c = found.cost.get(via);
  if (c === undefined) return undefined;
  const ra = 1 - a.f;
  const costA = ra * g.edgeCost[a.e]!;
  const lenA = ra * g.edgeLen[a.e]!;
  // A U-turn onto the same road in the other direction only at a dead end.
  const uturn = g.edgeTwin[a.e] === b.e ? 150 : 0;
  return {
    cost: costA + c + b.f * g.edgeCost[b.e]! + uturn,
    len: lenA + found.len.get(via)! + b.f * g.edgeLen[b.e]!,
  };
}

/** Match one shape (lon/lat) to the road graph. */
export function matchShape(g: RoadGraph, shape: LonLat[]): MatchResult {
  const samples = densify(
    shape.map((p) => g.toXY(p)),
    SAMPLE_M,
  );
  const cands: Candidate[][] = samples.map(([px, py]) => {
    let c = g.near(px, py, CANDIDATE_M);
    if (!c.length) c = g.near(px, py, CANDIDATE_FAR_M);
    return c.slice(0, MAX_CANDIDATES);
  });
  /** Samples whose candidates have grown. */
  const widened = new Set<number>();
  const emission = (c: Candidate) => -0.5 * (c.d / SIGMA_M) ** 2;

  // Viterbi, in chains broken where no candidates connect.
  const chains: { start: number; path: number[] }[] = [];
  let i = 0;
  while (i < samples.length) {
    while (i < samples.length && !cands[i]!.length) i++;
    if (i >= samples.length) break;
    const start = i;
    let score = cands[i]!.map(emission);
    /** Scores at each sample of the chain, to resume from. */
    let hist: number[][] = [score];
    let back: Int32Array[] = [];
    /**
     * The chain as it was when it last broke and candidates grew, and the candidates they replaced:
     * kept if growing them doesn't take it any further.
     */
    let before:
      | {
          i: number;
          score: number[];
          hist: number[][];
          back: Int32Array[];
          cands: Map<number, Candidate[]>;
        }
      | undefined;
    for (; i + 1 < samples.length; i++) {
      const next = cands[i + 1]!;
      if (!next.length) break;
      const straight = Math.hypot(
        samples[i + 1]![0] - samples[i]![0],
        samples[i + 1]![1] - samples[i]![1],
      );
      const targets = new Set(next.map((c) => g.edgeFrom[c.e]!));
      const maxCost = SEARCH_FACTOR * straight + SEARCH_SLACK_M;
      const ns = Array.from({ length: next.length }, () => -Infinity);
      const bp = new Int32Array(next.length).fill(-1);
      cands[i]!.forEach((a, ai) => {
        if (score[ai] === -Infinity) return;
        const found = g.search(g.edgeTo[a.e]!, targets, maxCost);
        next.forEach((b, bi) => {
          const r = routeBetween(g, a, b, found);
          if (!r) return;
          const s =
            score[ai]! - Math.abs(r.cost - straight) / BETA_M + emission(b);
          if (s > ns[bi]!) {
            ns[bi] = s;
            bp[bi] = ai;
          }
        });
      });
      if (ns.every((s) => s === -Infinity)) {
        // Nothing connects: the road the route is on may have been left out of the nearest
        // candidates, here or a few samples back where it parted from the one taken (beside a
        // motorway, its ways and links crowd out Phibbs Exchange's bus ramp onto the Ironworkers
        // bridge; in the exchange, short bay roads crowd out the way out), or the nearer of two roads
        // one above the other was taken and has just turned off (Granville Street under the Granville
        // Bridge's deck, 400 m from where they part). Each sample's candidates
        // can grow once, to every road within CANDIDATE_FAR_M: grow those of the last few samples
        // and resume before them, and break the chain only when none can.
        const from = Math.max(start, i - WIDEN_SAMPLES);
        const grown = new Map<number, Candidate[]>();
        for (let j = from; j <= i + 1; j++) {
          if (widened.has(j)) continue;
          widened.add(j);
          const [px, py] = samples[j]!;
          const all = g.near(px, py, CANDIDATE_FAR_M);
          if (all.length > cands[j]!.length) {
            grown.set(j, cands[j]!);
            cands[j] = all;
          }
        }
        if (!grown.size) break;
        if (!before || i > before.i)
          before = {
            i,
            score,
            hist: hist.slice(),
            back: back.slice(),
            cands: grown,
          };
        else
          for (const [j, c] of grown)
            if (!before.cands.has(j)) before.cands.set(j, c);
        const r = Math.max(start, from - 1);
        back.length = r - start;
        hist.length = r - start + 1;
        if (r === from) hist[0] = cands[r]!.map(emission);
        score = hist[r - start]!;
        i = r - 1;
        continue;
      }
      back.push(bp);
      hist.push(ns);
      score = ns;
    }
    if (before && i <= before.i) {
      // Growing the candidates didn't get past the break: keep the chain as it was.
      for (const [j, c] of before.cands) if (j <= before.i) cands[j] = c;
      ({ i, score, hist, back } = before);
    }
    // Backtrack.
    let best = 0;
    score.forEach((s, k) => {
      if (s > score[best]!) best = k;
    });
    const path = [best];
    for (let k = back.length - 1; k >= 0; k--)
      path.push(back[k]![path[path.length - 1]!]!);
    path.reverse();
    chains.push({ start, path });
    i = start + path.length;
  }

  // Pieces: road edges along each chain, GTFS samples between chains.
  const pieces: MatchPiece[] = [];
  const pushEdge = (edge: number, f0: number, f1: number) => {
    const last = pieces[pieces.length - 1];
    if (
      last
      && "edge" in last
      && last.edge === edge
      && Math.abs(last.f1 - f0) < 1e-6
    )
      last.f1 = f1;
    else if (f1 > f0 + 1e-9 || !last) pieces.push({ edge, f0, f1 });
  };
  let matchedSamples = 0;
  let prevEnd = 0;
  /** Where the last chain ended on the roads. */
  let prevAt: [number, number] | undefined;
  for (const ch of chains) {
    const at = (k: number) => cands[ch.start + k]![ch.path[k]!]!;
    // Between chains, the GTFS samples, joined to where the chains end on the roads: also where a
    // chain broke because no route connects one sample's candidates to the next's, so the line
    // doesn't jump.
    if (ch.start > 0) {
      const raw = samples.slice(Math.max(0, prevEnd - 1), ch.start + 1);
      if (prevAt) raw[0] = prevAt;
      raw[raw.length - 1] = g.at(at(0).e, at(0).f);
      pieces.push({ raw: raw.map(([px, py]) => g.toLonLat(px, py)) });
    }
    matchedSamples += ch.path.length;
    let cur = at(0);
    for (let k = 1; k < ch.path.length; k++) {
      let nxt = at(k);
      if (aheadOnEdge(g, cur, nxt)) {
        nxt = { ...nxt, f: Math.max(cur.f, nxt.f) };
        pushEdge(cur.e, cur.f, nxt.f);
      } else {
        pushEdge(cur.e, cur.f, 1);
        const straight = Math.hypot(
          samples[ch.start + k]![0] - samples[ch.start + k - 1]![0],
          samples[ch.start + k]![1] - samples[ch.start + k - 1]![1],
        );
        const found = g.search(
          g.edgeTo[cur.e]!,
          new Set([g.edgeFrom[nxt.e]!]),
          SEARCH_FACTOR * straight + SEARCH_SLACK_M,
        );
        const via: number[] = [];
        let v = g.edgeFrom[nxt.e]!;
        while (v !== g.edgeTo[cur.e]!) {
          const e = found.pred.get(v);
          if (e === undefined) break;
          via.push(e);
          v = g.edgeFrom[e]!;
        }
        for (const e of via.reverse()) pushEdge(e, 0, 1);
        pushEdge(nxt.e, 0, nxt.f);
      }
      cur = nxt;
    }
    prevEnd = ch.start + ch.path.length;
    prevAt = g.at(cur.e, cur.f);
  }
  if (prevEnd < samples.length) {
    const raw = samples.slice(Math.max(0, prevEnd - 1));
    if (prevAt) raw[0] = prevAt;
    pieces.push({ raw: raw.map(([px, py]) => g.toLonLat(px, py)) });
  }

  const coords: LonLat[] = [];
  const add = (p: LonLat) => {
    const l = coords[coords.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 1e-7 || Math.abs(l[1] - p[1]) > 1e-7)
      coords.push(p);
  };
  for (const p of pieces) {
    if ("raw" in p) p.raw.forEach(add);
    else {
      add(g.toLonLat(...g.at(p.edge, p.f0)));
      add(g.toLonLat(...g.at(p.edge, p.f1)));
    }
  }
  return {
    coords: coords.length >= 2 ? coords : shape.slice(),
    pieces,
    matched: samples.length ? matchedSamples / samples.length : 0,
  };
}
