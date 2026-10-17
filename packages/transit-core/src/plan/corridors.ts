// Bus corridors (packages/transit-core/DESIGN.md#bus-corridors): the street network the bus patterns
// use, one line per stretch of road, each listing the patterns that run along it. Built from the
// road-matched shapes, so routes on the same road share a corridor exactly. The client colours each
// corridor by how often buses pass, so a street never shows more than one line.
//
// Corridors are derived per plan build, not features: they have no persistent ids (OSM ways split
// and merge), and refer to patterns by their index in the plan.

import { localProjector, simplify, type LonLat, round } from "../geo.ts";
import type { CorridorRef, PlanCorridor } from "./types.ts";
import type { MatchPiece, RoadGraph } from "./road-match.ts";

/** A pattern counts as using a road edge when it covers at least this share of it. */
const MIN_EDGE_SHARE = 0.5;
/** Corridor geometry tolerance (m). */
const SIMPLIFY_M = 1;
/** Carriageways of a divided road are at most this far apart (m). */
const CARRIAGEWAY_M = 40;
/** Merged corridors are sampled this often (m) and their points snapped within SNAP_M (m). */
const MERGE_STEP_M = 6;
const SNAP_M = 3.5;
/** A pattern on both sides of up to this many stretches of a merged line runs through them. */
const MAX_GAP_EDGES = 4;
/** Merged corridors' geometry tolerance (m): they're drawn zoomed out. */
const MERGED_SIMPLIFY_M = 3;

/** A stretch between two nodes and the patterns along it: [direction from a to b, along where it enters]. */
interface UsedEdge {
  a: number;
  b: number;
  uses: Map<number, [1 | -1, number]>;
}

/** Edges used by the same patterns, joined into corridors through nodes where only they meet. */
function chainEdges(
  edges: UsedEdge[],
  at: (node: number) => LonLat,
  simplifyM: number,
): PlanCorridor[] {
  const out: PlanCorridor[] = [];
  const sig = edges.map((e) =>
    [...e.uses.keys()].sort((x, y) => x - y).join(","),
  );
  const byNode = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const v of [e.a, e.b]) {
      let l = byNode.get(v);
      if (!l) byNode.set(v, (l = []));
      l.push(i);
    }
  });
  const same = (v: number, s: string) =>
    byNode.get(v)!.filter((i) => sig[i] === s);
  const used = new Set<number>();
  const walk = (start: number, first: number) => {
    const s = sig[first]!;
    const steps: [number, 1 | -1][] = [];
    let v = start;
    let i = first;
    for (;;) {
      used.add(i);
      const fwd = edges[i]!.a === v;
      steps.push([i, fwd ? 1 : -1]);
      v = fwd ? edges[i]!.b : edges[i]!.a;
      const next = same(v, s).filter((x) => x !== i);
      if (next.length !== 1 || used.has(next[0]!) || same(v, s).length !== 2)
        break;
      i = next[0]!;
    }
    const nodes = [
      start,
      ...steps.map(([x, d]) => (d === 1 ? edges[x]!.b : edges[x]!.a)),
    ];
    const coords = simplify(nodes.map(at), simplifyM).map(
      ([lon, lat]): LonLat => [round(lon, 6), round(lat, 6)],
    );
    const [i0, d0] = steps[0]!;
    const [iN] = steps[steps.length - 1]!;
    const refs: CorridorRef[] = [...edges[i0]!.uses].map(([pattern, [dir]]) => {
      const rel = (dir * d0) as 1 | -1;
      // Where the pattern enters this corridor: its first edge, or its last when it runs the other way.
      const entry = (rel === 1 ? edges[i0]! : edges[iN]!).uses.get(pattern)!;
      return [pattern, rel, entry[1]];
    });
    out.push({ coords, refs });
  };
  for (const [v, list] of byNode)
    for (const i of list)
      if (!used.has(i) && same(v, sig[i]!).length !== 2) walk(v, i);
  // Loops: every node has two of the same.
  edges.forEach((e, i) => {
    if (!used.has(i)) walk(e.a, i);
  });
  return out;
}

export interface PatternMatch {
  pattern: number;
  pieces: MatchPiece[];
}

export function buildCorridors(
  g: RoadGraph,
  matches: PatternMatch[],
): PlanCorridor[] {
  /** Per canonical edge (the lower of an edge and its twin): pattern → [direction, along where it enters]. */
  const uses = new Map<number, Map<number, [1 | -1, number]>>();
  const out: PlanCorridor[] = [];
  for (const { pattern, pieces } of matches) {
    let along = 0;
    for (const p of pieces) {
      if ("raw" in p) {
        // No road here: the pattern's own geometry, not merged with others.
        const coords = p.raw.map(([lon, lat]): LonLat => [
          round(lon, 6),
          round(lat, 6),
        ]);
        out.push({ coords, refs: [[pattern, 1, Math.round(along)]] });
        for (let k = 1; k < p.raw.length; k++) {
          const [ax, ay] = g.toXY(p.raw[k - 1]!);
          const [bx, by] = g.toXY(p.raw[k]!);
          along += Math.hypot(bx - ax, by - ay);
        }
        continue;
      }
      const len = (p.f1 - p.f0) * g.edgeLen[p.edge]!;
      if (p.f1 - p.f0 >= MIN_EDGE_SHARE) {
        const twin = g.edgeTwin[p.edge]!;
        const canon = twin >= 0 && twin < p.edge ? twin : p.edge;
        let m = uses.get(canon);
        if (!m) uses.set(canon, (m = new Map()));
        if (!m.has(pattern))
          m.set(pattern, [
            canon === p.edge ? 1 : -1,
            Math.round(along - p.f0 * g.edgeLen[p.edge]!),
          ]);
      }
      along += len;
    }
  }

  out.push(
    ...chainEdges(
      [...uses].map(([e, m]) => ({
        a: g.edgeFrom[e]!,
        b: g.edgeTo[e]!,
        uses: m,
      })),
      (n) => g.toLonLat(g.x[n]!, g.y[n]!),
      SIMPLIFY_M,
    ),
  );
  return out;
}

/**
 * Corridors for zoomed-out views: the two carriageways of a divided road (one-way corridors running
 * opposite ways side by side, within CARRIAGEWAY_M) merged into one corridor on their centreline,
 * carrying both directions' patterns: one carriageway moves halfway to the other, onto the centreline,
 * and takes on the other's patterns.
 */
export function mergeCarriageways(corridors: PlanCorridor[]): PlanCorridor[] {
  if (!corridors.length) return [];
  const proj = localProjector(corridors[0]!.coords[0]![1]);
  interface Line {
    pts: [number, number][];
    /** Distance along the corridor's coordinates at each point (m). */
    s: number[];
    length: number;
    /** 1 or -1: every pattern runs this way along it; 0: both ways. */
    oneway: number;
    refs: CorridorRef[];
  }
  const lines: Line[] = corridors.map((c) => {
    const xy = c.coords.map((p) => proj.toXY(p));
    const pts: [number, number][] = [xy[0]!];
    const s = [0];
    for (let k = 1; k < xy.length; k++) {
      const [ax, ay] = xy[k - 1]!;
      const [bx, by] = xy[k]!;
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / MERGE_STEP_M));
      for (let j = 1; j <= n; j++) {
        pts.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
        s.push(s[s.length - 1]! + d / n);
      }
    }
    const dirs = new Set(c.refs.map((r) => r[1]));
    return {
      pts,
      s,
      length: s[s.length - 1]!,
      oneway: dirs.size === 1 ? [...dirs][0]! : 0,
      refs: c.refs,
    };
  });

  // Segments of one-way corridors, indexed on a grid.
  const cell = (x: number, y: number) =>
    Math.floor(x / CARRIAGEWAY_M) * 1_000_003 + Math.floor(y / CARRIAGEWAY_M);
  const grid = new Map<number, [number, number][]>();
  lines.forEach((l, i) => {
    if (!l.oneway) return;
    for (let k = 0; k + 1 < l.pts.length; k++) {
      const c = cell(l.pts[k]![0], l.pts[k]![1]);
      let list = grid.get(c);
      if (!list) grid.set(c, (list = []));
      list.push([i, k]);
    }
  });
  const unit = (l: Line, k: number): [number, number] => {
    const a = l.pts[Math.max(0, k - 1)]!;
    const b = l.pts[Math.min(l.pts.length - 1, k + 1)]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [((b[0] - a[0]) / d) * l.oneway, ((b[1] - a[1]) / d) * l.oneway];
  };
  /** Per point: the other carriageway's segment alongside it, and the centreline point between them. */
  const partner = lines.map((l, i) =>
    l.pts.map((p, k) => {
      if (!l.oneway) return undefined;
      const t = unit(l, k);
      let best:
        { line: number; seg: number; mid: [number, number] } | undefined;
      let bestD = CARRIAGEWAY_M;
      const cx = Math.floor(p[0] / CARRIAGEWAY_M);
      const cy = Math.floor(p[1] / CARRIAGEWAY_M);
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gy = cy - 1; gy <= cy + 1; gy++)
          for (const [j, m] of grid.get(gx * 1_000_003 + gy) ?? []) {
            if (j === i) continue;
            const o = lines[j]!;
            const u = unit(o, m);
            // The other carriageway runs the opposite way…
            if (t[0] * u[0] + t[1] * u[1] > -0.85) continue;
            const a = o.pts[m]!;
            const b = o.pts[m + 1]!;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const l2 = dx * dx + dy * dy;
            const f =
              l2 > 0 ?
                Math.max(
                  0,
                  Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
                )
              : 0;
            const ox = a[0] + dx * f - p[0];
            const oy = a[1] + dy * f - p[1];
            const d = Math.hypot(ox, oy);
            // …alongside it, not ahead or behind.
            if (d >= bestD || Math.abs(ox * t[0] + oy * t[1]) > 0.4 * d)
              continue;
            bestD = d;
            best = { line: j, seg: m, mid: [p[0] + ox / 2, p[1] + oy / 2] };
          }
      return best;
    }),
  );

  // Snap points into nodes, and record which patterns use each stretch between them. Of two
  // carriageways side by side, the one listed first carries the geometry, moved to the centreline;
  // the other only adds its patterns to that one's stretches (snapping both would zigzag between
  // them and break the corridor into pieces).
  const nodes: [number, number][] = [];
  const nodeGrid = new Map<number, number[]>();
  const nodeAt = (p: [number, number]): number => {
    const cx = Math.floor(p[0] / SNAP_M);
    const cy = Math.floor(p[1] / SNAP_M);
    let best = -1;
    let bestD = SNAP_M;
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++)
        for (const n of nodeGrid.get(gx * 1_000_003 + gy) ?? []) {
          const d = Math.hypot(nodes[n]![0] - p[0], nodes[n]![1] - p[1]);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
    if (best >= 0) return best;
    nodes.push(p);
    const key = cx * 1_000_003 + cy;
    let list = nodeGrid.get(key);
    if (!list) nodeGrid.set(key, (list = []));
    list.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const edges = new Map<string, UsedEdge>();
  const alongOf = (l: Line, d: number, entry: number, s: number) =>
    d === 1 ? entry + s : entry + l.length - s;
  const addUse = (e: UsedEdge, pattern: number, dir: 1 | -1, along: number) => {
    if (!e.uses.has(pattern)) e.uses.set(pattern, [dir, Math.round(along)]);
  };
  /** Per line and point: the edge reaching it, and whether the line runs a→b along that edge. */
  const reached = lines.map((l) =>
    l.pts.map((): [UsedEdge, 1 | -1] | undefined => undefined),
  );
  const secondary = (i: number, k: number) => {
    const q = partner[i]![k];
    return q !== undefined && q.line < i;
  };
  lines.forEach((l, i) => {
    let prev = -1;
    let prevS = 0;
    let last: [UsedEdge, 1 | -1] | undefined;
    l.pts.forEach((p, k) => {
      const q = partner[i]![k];
      if (secondary(i, k)) {
        // Join the centreline where this carriageway meets it, then leave the stretch to the other.
        if (prev >= 0) {
          const n = nodeAt(q!.mid);
          if (n !== prev) link(l, prev, n, prevS, l.s[k]!);
        }
        prev = -1;
        last = undefined;
        return;
      }
      const at = q ? q.mid : p;
      // Coming off the centreline: start from where this carriageway left it.
      if (prev < 0 && k > 0 && secondary(i, k - 1)) {
        prev = nodeAt(partner[i]![k - 1]!.mid);
        prevS = l.s[k - 1]!;
      }
      const n = nodeAt(at);
      if (prev >= 0 && n !== prev) last = link(l, prev, n, prevS, l.s[k]!);
      if (n !== prev) {
        prev = n;
        prevS = l.s[k]!;
      }
      reached[i]![k] = last;
    });
  });
  function link(
    l: Line,
    from: number,
    to: number,
    s0: number,
    s1: number,
  ): [UsedEdge, 1 | -1] {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const key = `${a},${b}`;
    let e = edges.get(key);
    if (!e) edges.set(key, (e = { a, b, uses: new Map() }));
    const orient = from === a ? 1 : -1;
    for (const [pattern, d, entry] of l.refs)
      addUse(
        e,
        pattern,
        (orient * d) as 1 | -1,
        alongOf(l, d, entry, d === 1 ? s0 : s1),
      );
    return [e, orient];
  }
  // The other carriageway's patterns, on the stretches alongside it.
  lines.forEach((l, j) =>
    l.pts.forEach((_, k) => {
      if (!secondary(j, k)) return;
      const q = partner[j]![k]!;
      const o = lines[q.line]!;
      const hit = reached[q.line]![q.seg + 1] ?? reached[q.line]![q.seg];
      if (!hit) return;
      const [e, orient] = hit;
      // This carriageway runs against the other one's direction of drawing.
      const t = unit(l, k);
      const v = [
        o.pts[q.seg + 1]![0] - o.pts[q.seg]![0],
        o.pts[q.seg + 1]![1] - o.pts[q.seg]![1],
      ];
      const along = t[0] * v[0]! + t[1] * v[1]! > 0 ? 1 : -1;
      for (const [pattern, d, entry] of l.refs)
        addUse(
          e,
          pattern,
          (orient * along) as 1 | -1,
          alongOf(l, d, entry, l.s[k]!),
        );
    }),
  );
  // A pattern missing from a few stretches of a line but on both sides of them (where no point of
  // the other carriageway projected) runs through them too.
  for (const seq of reached) {
    const steps: [UsedEdge, 1 | -1][] = [];
    for (const r of seq) if (r && r !== steps[steps.length - 1]) steps.push(r);
    for (let k = 1; k + 1 < steps.length; k++) {
      const [e, orient] = steps[k]!;
      const [before, orientBefore] = steps[k - 1]!;
      for (const [pattern, [dir, along]] of before.uses) {
        if (e.uses.has(pattern)) continue;
        const after = steps
          .slice(k + 1, k + 1 + MAX_GAP_EDGES)
          .some(([x]) => x.uses.has(pattern));
        // Its direction along the line carries over.
        if (after)
          e.uses.set(pattern, [(dir * orientBefore * orient) as 1 | -1, along]);
      }
    }
  }
  return chainEdges(
    [...edges.values()],
    (n) => proj.toLonLat(nodes[n]![0], nodes[n]![1]),
    MERGED_SIMPLIFY_M,
  );
}
