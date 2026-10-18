// Line-level geometry for drawing SkyTrain (packages/transit-map/README.md#rendering), derived from the
// track network:
// - service track: where passenger trains run, from routing every stop pattern between its platforms,
//   and where they stand at stops and wait at termini (serviceExtents), plus the crossovers, pockets and sidings joining it at two or more points. Tail
//   tracks, spurs and main track past the last platform aren't service track: trains turn back or
//   pull in on them, but they're drawn grey like yards, not in the line's colour.
// - centrelines: every main service track moved halfway towards its parallel partner, measured per
//   point and smoothed, so both tracks of a pair become (nearly) one line and junctions join cleanly.
//   Drawn as a stroke at city zoom.
// - ribbons: per line, the union of a band RIBBON_M wide around each of its service tracks, as one
//   polygon per line (track shared by several lines cut lengthwise along one spine per stretch, one
//   stripe per line).
//   Drawn as a fill from station zoom, where the line has its true width: no overlaps, so it fades
//   evenly, and widths change smoothly where tracks spread apart or come together.
// - tracks: every non-yard track, split into its service and other parts, for hairlines and grey track.

import ClipperLib from "clipper-lib";
import {
  cumulativeLengths,
  localProjector,
  simplify,
  sliceLine,
  round,
  type LonLat,
} from "../geo.ts";
import type { ServicePlan } from "../plan/types.ts";
import {
  kinematicsFor,
  type KinematicsConfig,
} from "../movement/kinematics.ts";
import { terminusBerths, trainSpan } from "./berths.ts";
import type { PathPiece, TrackGraph, TrackPos } from "./graph.ts";
import { routePattern } from "./patterns.ts";
import type { PlatformAssignment } from "./platforms.ts";
import type { InfraCollection, SegmentKind, SegmentProps } from "./types.ts";

/** The guideway's drawn width (m): two tracks ≈4 m apart, with a margin. */
export const RIBBON_M = 9;
/** A track's parallel partner is within this distance (m)… */
const PARTNER_M = 25;
/** …and runs within this angle of it (cosine). */
const PARALLEL_COS = 0.94;
/** Tracks are sampled this often (m) for centrelines and ribbons. */
const STEP_M = 4;
/** Centreline shifts are averaged over this distance along the track (m), each way. */
const SMOOTH_M = 30;
/** Output geometry tolerance (m). */
const SIMPLIFY_M = 0.25;
/** Service extents closer than this to a segment's end reach its node (m). */
const END_M = 1;
/** Pieces of track shorter than this aren't drawn (m). */
const MIN_PIECE_M = 0.5;
/** Track that joins service track at two or more points is drawn with it (crossovers, pockets). */
const CONNECTOR_KINDS = new Set<SegmentKind>(["crossover", "pocket", "siding"]);

/** The stretch of each segment passenger trains run along or stand on: [from, to] offsets (m). */
export type ServiceExtents = Map<string, [number, number]>;

export interface ServiceInput {
  graph: TrackGraph;
  plan: ServicePlan;
  /** The rail routes (lines) drawn. */
  routeKeys: Set<string>;
  platforms: Map<string, PlatformAssignment>;
  /** Per-pattern overrides (PlatformReport.patternPositions). */
  patternPositions?: Map<number, Map<number, TrackPos>> | undefined;
  /** For train lengths. */
  kin: KinematicsConfig;
  /** operations.json → turnback.maxPullUpM. */
  maxPullUpM: number;
}

/**
 * Where passenger trains run: every pattern of `routeKeys` routed between its platforms
 * (routePattern), with the track a stopped train stands on at each stop and at its last stop's
 * berth. Each segment's extent is the span of all of these over it. Adds to `into`, so several
 * plans (feed versions) can be combined.
 */
export function serviceExtents(
  input: ServiceInput,
  into: ServiceExtents = new Map(),
): ServiceExtents {
  const { graph: g, plan } = input;
  const add = (p: PathPiece) => {
    const lo = Math.min(p.from, p.to);
    const hi = Math.max(p.from, p.to);
    const e = into.get(p.seg);
    if (e) {
      e[0] = Math.min(e[0], lo);
      e[1] = Math.max(e[1], hi);
    } else into.set(p.seg, [lo, hi]);
  };
  for (const pattern of plan.patterns) {
    if (!input.routeKeys.has(pattern.route)) continue;
    const { hops, positions } = routePattern(
      g,
      plan,
      input.platforms,
      pattern,
      input.patternPositions,
    );
    for (const hop of hops) for (const p of hop?.pieces ?? []) add(p);
    const len = kinematicsFor(input.kin, "skytrain", pattern.route).length;
    // A train at its last stop may wait pulled up to the buffer (terminusBerths' first choice, as
    // run inference allocates it). Other stub tracks it may wait on stay grey (Waterfront's Expo tail).
    const last = positions.at(-1)!;
    const stands = positions.filter((p) => p.seg);
    if (last.seg)
      stands.push(terminusBerths(g, last, [], len, input.maxPullUpM)[0]!);
    for (const pos of stands) for (const p of trainSpan(g, pos, len)) add(p);
  }
  return into;
}

type XY = [number, number];

export interface LineGeometry {
  type: "FeatureCollection";
  features: (CentrelineFeature | RibbonFeature | TrackFeature)[];
}

export interface CentrelineFeature {
  type: "Feature";
  properties: {
    type: "centre";
    /** The line it's drawn in (the first of `lines`). */
    line: string;
    lines: string[];
    /**
     * Shared by several lines: drawn along one spine per stretch, west to east, as `stripes`
     * lengthwise stripes, the first line (stripe 0) on the left. One feature per stripe.
     */
    shared: boolean;
    stripe?: number;
    stripes?: number;
  };
  geometry: { type: "LineString"; coordinates: LonLat[] };
}

export interface RibbonFeature {
  type: "Feature";
  properties: { type: "ribbon"; line: string };
  geometry:
    | { type: "Polygon"; coordinates: LonLat[][] }
    | { type: "MultiPolygon"; coordinates: LonLat[][][] };
}

export interface TrackFeature {
  type: "Feature";
  properties: {
    type: "track";
    /** The line it's drawn in (the first of `lines`). */
    line: string;
    lines: string[];
    kind: SegmentKind;
    /** Service track (in the line's colour) or not (grey). */
    service: boolean;
  };
  geometry: { type: "LineString"; coordinates: LonLat[] };
}

interface Track {
  props: SegmentProps;
  pts: XY[];
}

function densify(pts: XY[], step: number): XY[] {
  const out: XY[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++)
      out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

function tangent(pts: XY[], i: number): XY {
  const a = pts[Math.max(0, i - 1)]!;
  const b = pts[Math.min(pts.length - 1, i + 1)]!;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

/** Segments of a set of tracks, indexed on a grid. */
class SegmentIndex {
  private grid = new Map<string, [number, number][]>();
  private tracks: Track[];
  constructor(tracks: Track[]) {
    this.tracks = tracks;
    tracks.forEach((t, i) => {
      for (let k = 0; k + 1 < t.pts.length; k++) {
        const key = this.key(t.pts[k]!);
        let l = this.grid.get(key);
        if (!l) this.grid.set(key, (l = []));
        l.push([i, k]);
      }
    });
  }
  private key([x, y]: XY): string {
    return `${Math.floor(x / PARTNER_M)},${Math.floor(y / PARTNER_M)}`;
  }
  /** The nearest point within `within` on a parallel track other than `self` (and `accept`ed). */
  partner(
    p: XY,
    t: XY,
    self: number,
    within = PARTNER_M,
    accept?: (track: number) => boolean,
  ): XY | undefined {
    const cx = Math.floor(p[0] / PARTNER_M);
    const cy = Math.floor(p[1] / PARTNER_M);
    let best: XY | undefined;
    let bestD = within;
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++)
        for (const [ti, k] of this.grid.get(`${i},${j}`) ?? []) {
          if (ti === self || (accept && !accept(ti))) continue;
          const pts = this.tracks[ti]!.pts;
          const a = pts[k]!;
          const b = pts[k + 1]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len = Math.hypot(dx, dy) || 1;
          if (Math.abs((dx * t[0] + dy * t[1]) / len) < PARALLEL_COS) continue;
          const f = Math.max(
            0,
            Math.min(
              1,
              ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len),
            ),
          );
          const q: XY = [a[0] + dx * f, a[1] + dy * f];
          const ox = q[0] - p[0];
          const oy = q[1] - p[1];
          const d = Math.hypot(ox, oy);
          // Beside it, not ahead or behind (the next segment of the same track, at a shared node).
          if (
            d > 0.5
            && d < bestD
            && Math.abs(ox * t[0] + oy * t[1]) < 0.3 * d
          ) {
            bestD = d;
            best = q;
          }
        }
    return best;
  }
}

/** Each point moved halfway to its parallel partner, the shifts smoothed along the track. */
function centreline(track: Track, index: SegmentIndex, self: number): XY[] {
  const { pts } = track;
  const found = pts.map((p, i): XY | undefined => {
    const q = index.partner(p, tangent(pts, i), self);
    return q ? [(q[0] - p[0]) / 2, (q[1] - p[1]) / 2] : undefined;
  });
  // Points without a partner within a few samples of one that has (segment ends, where the partner
  // track's own segment ends a little earlier) take its shift, so centrelines join up.
  const reach = Math.round(SMOOTH_M / STEP_M);
  const shift = found.map((v, i): XY => {
    if (v) return v;
    for (let k = 1; k <= reach; k++) {
      const near = found[i - k] ?? found[i + k];
      if (near) return near;
    }
    return [0, 0];
  });
  const window = Math.round(SMOOTH_M / STEP_M);
  return pts.map((p, i) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (
      let k = Math.max(0, i - window);
      k <= Math.min(pts.length - 1, i + window);
      k++
    ) {
      sx += shift[k]![0];
      sy += shift[k]![1];
      n++;
    }
    return [p[0] + sx / n, p[1] + sy / n];
  });
}

/** Clipper works in integers: millimetres. */
const SCALE = 1000;
type Paths = ClipperLib.Paths;

const toPath = (pts: XY[]): ClipperLib.Path =>
  pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));

/** The union of bands of half-width r around polylines (round joins and ends). */
function bands(lines: XY[][], r: number): Paths {
  const co = new ClipperLib.ClipperOffset(2, 0.1 * SCALE);
  co.AddPaths(
    lines.map(toPath),
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etOpenRound,
  );
  const out: Paths = [];
  co.Execute(out, r * SCALE);
  return out;
}

function clip(op: ClipperLib.ClipType, a: Paths, b: Paths): Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(
    op,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return out;
}

/** As polygons with holes (outer ring first). */
function polygons(paths: Paths): XY[][][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  const ring = (p: ClipperLib.Path): XY[] => {
    const r = p.map((q): XY => [q.X / SCALE, q.Y / SCALE]);
    return [...r, r[0]!];
  };
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((e) => [
    ring(e.outer),
    ...e.holes.map(ring),
  ]);
}

/** Track ends this close are joined into one spine (m). */
const JOIN_M = 1;
/**
 * Shared stretches shorter than this aren't striped (a crossover and a few metres of track by a
 * station: a sliver of stripes between the lines' own track); they're drawn in the first line's colour.
 */
const MIN_STRIPED_M = 100;
/**
 * A line's own track this close to a shared stretch's spine runs beside it (a third track through a
 * station): it's drawn as part of the stretch, so the stripes run the stretch's whole width.
 */
const BESIDE_M = 15;
/** Where lines leave a corridor is judged from their own track within this distance of its ends (m). */
const ENDS_M = 150;
/** A spine starting this close to another's end continues it, blended over JOIN_BLEND_M. */
const JOIN_BLEND_M = 40;

/** A test for points beside a polyline within `d` (not ahead of or behind its ends). */
function besideLine(line: XY[], d: number): (p: XY) => boolean {
  const pts = densify(line, STEP_M);
  const grid = new Map<string, [XY, XY][]>();
  pts.forEach((q, i) => {
    const k = `${Math.floor(q[0] / d)},${Math.floor(q[1] / d)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push([q, tangent(pts, i)]);
  });
  return (p) => {
    const cx = Math.floor(p[0] / d);
    const cy = Math.floor(p[1] / d);
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++)
        for (const [q, t] of grid.get(`${i},${j}`) ?? []) {
          const dx = p[0] - q[0];
          const dy = p[1] - q[1];
          if (
            Math.hypot(dx, dy) < d
            && Math.abs(dx * t[0] + dy * t[1]) <= STEP_M
          )
            return true;
        }
    return false;
  };
}

/** The runs of consecutive points where `mask` is `want` (two points or more). */
function runs(pts: XY[], mask: boolean[], want: boolean): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [];
  pts.forEach((p, i) => {
    if (mask[i] === want) cur.push(p);
    else {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  });
  if (cur.length > 1) out.push(cur);
  return out;
}

const lengthOf = (pts: XY[]) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++)
    len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return len;
};

/**
 * A corridor's lines in stripe order, left first (going west to east): by which side of the spine
 * each line's own track lies near the corridor's ends, where the lines go their own ways, so each
 * stripe runs straight on into its line (Lougheed: Millennium leaves to the north, Expo to the
 * south). Lines with no own track there keep their order.
 */
function bySide(
  lines: string[],
  spine: XY[],
  tracks: { props: SegmentProps; pts: XY[] }[],
): string[] {
  const ends = [0, spine.length - 1].map((i) => ({
    at: spine[i]!,
    t: tangent(spine, i),
  }));
  const side = new Map<string, number>();
  for (const t of tracks) {
    if (t.props.lines.length !== 1 || !lines.includes(t.props.lines[0]!))
      continue;
    for (const p of t.pts)
      for (const {
        at,
        t: [tx, ty],
      } of ends) {
        const dx = p[0] - at[0];
        const dy = p[1] - at[1];
        if (Math.hypot(dx, dy) > ENDS_M) continue;
        const line = t.props.lines[0]!;
        side.set(line, (side.get(line) ?? 0) + (dx * -ty + dy * tx));
      }
  }
  if (lines.some((l) => !side.has(l))) return lines;
  return [...lines].sort((a, b) => side.get(b)! - side.get(a)!);
}

/**
 * A spine, smoothed over SMOOTH_M, moved to the middle of the corridor's tracks: at each point,
 * halfway between the outermost track points beside it, the shifts smoothed over SMOOTH_M too.
 */
function recentre(line: XY[], trackPts: XY[]): XY[] {
  // Smoothed first: where the spine passes from one track's centreline to another's it jogs
  // sideways a metre or two, which would step the stripes.
  const w = Math.round(SMOOTH_M / STEP_M);
  const rough = densify(line, STEP_M);
  const spine = rough.map((_, i): XY => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (
      let k = Math.max(0, i - w);
      k <= Math.min(rough.length - 1, i + w);
      k++
    ) {
      x += rough[k]![0];
      y += rough[k]![1];
      n++;
    }
    return [x / n, y / n];
  });
  const grid = new Map<string, XY[]>();
  const cell = BESIDE_M;
  for (const q of trackPts) {
    const k = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(q);
  }
  const shift = spine.map((p, i): number => {
    const [tx, ty] = tangent(spine, i);
    let lo = Infinity;
    let hi = -Infinity;
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let a = cx - 1; a <= cx + 1; a++)
      for (let b = cy - 1; b <= cy + 1; b++)
        for (const q of grid.get(`${a},${b}`) ?? []) {
          const dx = q[0] - p[0];
          const dy = q[1] - p[1];
          if (Math.abs(dx * tx + dy * ty) > STEP_M) continue;
          const o = dx * -ty + dy * tx;
          if (Math.abs(o) > BESIDE_M) continue;
          lo = Math.min(lo, o);
          hi = Math.max(hi, o);
        }
    return lo <= hi ? (lo + hi) / 2 : 0;
  });
  return spine.map((p, i) => {
    let sum = 0;
    let n = 0;
    for (
      let k = Math.max(0, i - w);
      k <= Math.min(spine.length - 1, i + w);
      k++
    ) {
      sum += shift[k]!;
      n++;
    }
    const [tx, ty] = tangent(spine, i);
    return [p[0] - ty * (sum / n), p[1] + tx * (sum / n)];
  });
}

/**
 * Stretches whose spines follow on (one starts beside the other's last JOIN_BLEND_M, where the
 * shared track moves over to the other track of a pair) joined into one, the spine blended across.
 */
function joinStretches<T>(
  list: { spine: XY[]; tracks: T[] }[],
): { spine: XY[]; tracks: T[] }[] {
  const out = [...list];
  for (let changed = true; changed;) {
    changed = false;
    for (const a of out)
      for (const b of out) {
        if (a === b) continue;
        const start = b.spine[0]!;
        let k = -1;
        let best = PARTNER_M;
        a.spine.forEach((q, i) => {
          const d = Math.hypot(q[0] - start[0], q[1] - start[1]);
          if (d < best) [best, k] = [d, i];
        });
        if (k < 0 || lengthOf(a.spine.slice(k)) > JOIN_BLEND_M * 2) continue;
        // Back along a by JOIN_BLEND_M, then straight on to b.
        let cut = k;
        while (cut > 0 && lengthOf(a.spine.slice(cut, k + 1)) < JOIN_BLEND_M)
          cut--;
        a.spine = [...a.spine.slice(0, cut + 1), ...b.spine];
        a.tracks.push(...b.tracks);
        out.splice(out.indexOf(b), 1);
        changed = true;
        break;
      }
  }
  return out;
}

/**
 * Shared tracks chained into spines: from the longest track, the straightest continuation at each
 * end, then every track running beside that chain is part of the same stretch. One smooth line per
 * stretch, however many tracks it has, so its stripes don't depend on how the tracks are arranged.
 * Each spine runs west to east.
 */
function spines(
  tracks: { pts: XY[]; centre: XY[] }[],
): { spine: XY[]; members: number[] }[] {
  const left = new Set(tracks.map((_, i) => i));
  const out: { spine: XY[]; members: number[] }[] = [];
  const near = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) < JOIN_M;
  while (left.size) {
    let seed = -1;
    for (const i of left)
      if (seed < 0 || tracks[i]!.pts.length > tracks[seed]!.pts.length)
        seed = i;
    left.delete(seed);
    // Oriented pieces: [track, reversed].
    let chain: [number, boolean][] = [[seed, false]];
    const oriented = ([i, rev]: [number, boolean]) =>
      rev ? [...tracks[i]!.pts].reverse() : tracks[i]!.pts;
    const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
    const neg = ([x, y]: XY): XY => [-x, -y];
    for (const forward of [true, false]) {
      for (;;) {
        // Forward: what starts where the chain ends; backward: what ends where it starts.
        const end = forward ? oriented(chain.at(-1)!) : oriented(chain[0]!);
        const at = forward ? end.at(-1)! : end[0]!;
        const dir = tangent(end, forward ? end.length - 1 : 0);
        let best: [number, boolean] | undefined;
        let bestCos = 0;
        for (const j of left) {
          const p = tracks[j]!.pts;
          const options: [boolean, XY, XY][] = [
            [
              false,
              forward ? p[0]! : p.at(-1)!,
              tangent(p, forward ? 0 : p.length - 1),
            ],
            [
              true,
              forward ? p.at(-1)! : p[0]!,
              neg(tangent(p, forward ? p.length - 1 : 0)),
            ],
          ];
          for (const [rev, q, t] of options) {
            const c = dot(t, dir);
            if (near(q, at) && c > bestCos) [bestCos, best] = [c, [j, rev]];
          }
        }
        if (!best) break;
        left.delete(best[0]);
        if (forward) chain.push(best);
        else chain = [best, ...chain];
      }
    }
    let spine = chain.flatMap(([i, rev]) => {
      const c = tracks[i]!.centre;
      return rev ? [...c].reverse() : c;
    });
    if (spine.at(-1)![0] < spine[0]![0]) spine = spine.reverse();
    const members = chain.map(([i]) => i);
    out.push({ spine, members });
    // Tracks beside the chain belong to its stretch.
    for (const i of left) {
      const pts = tracks[i]!.pts;
      if (
        pts.every((p) =>
          spine.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < PARTNER_M),
        )
      ) {
        left.delete(i);
        members.push(i);
      }
    }
  }
  return out;
}

/** A polyline moved `o` metres to its left (negative: right). */
function offsetLine(pts: XY[], o: number): XY[] {
  return pts.map((p, i) => {
    const [tx, ty] = tangent(pts, i);
    return [p[0] - ty * o, p[1] + tx * o];
  });
}

/**
 * The area between `lo` and `hi` metres left of a west-to-east spine (negative: right of it): one
 * of `n` lengthwise stripes, each RIBBON_M / n wide but the outer two, which reach out to `w`. It
 * ends square with the spine: beyond, each line's own track carries on.
 */
function stripeArea(spine: XY[], i: number, n: number, w: number): Paths {
  const step = RIBBON_M / n;
  const hi = i === 0 ? w : (n / 2 - i) * step;
  const lo = i === n - 1 ? -w : (n / 2 - i - 1) * step;
  return clip(
    ClipperLib.ClipType.ctUnion,
    [toPath([...offsetLine(spine, lo), ...offsetLine(spine, hi).reverse()])],
    [],
  );
}

/** A spine continued straight on `w` metres at the ends that run on (endsRunOn). */
function runOn(spine: XY[], [start, end]: [boolean, boolean], w: number): XY[] {
  const t0 = tangent(spine, 0);
  const tn = tangent(spine, spine.length - 1);
  return [
    ...(start ?
      [[spine[0]![0] - t0[0] * w, spine[0]![1] - t0[1] * w] as XY]
    : []),
    ...spine,
    ...(end ?
      [[spine.at(-1)![0] + tn[0] * w, spine.at(-1)![1] + tn[1] * w] as XY]
    : []),
  ];
}

/**
 * At each end of a corridor's spine, whether fewer than two of its lines carry on beyond it (one
 * just ends there, as Expo at Production Way–University): then the corridor runs on past it
 * (runOn), so that line's last stretch of track is striped too. Where lines go their own ways it
 * ends there, and each line's own track carries on in its colour.
 */
function endsRunOn(
  lines: string[],
  spine: XY[],
  tracks: { props: SegmentProps; pts: XY[] }[],
): [boolean, boolean] {
  return [0, spine.length - 1].map((i) => {
    const at = spine[i]!;
    const [tx, ty] = tangent(spine, i);
    const out = i === 0 ? -1 : 1;
    const on = new Set<string>();
    for (const t of tracks) {
      const line = t.props.lines[0]!;
      if (t.props.lines.length !== 1 || !lines.includes(line)) continue;
      for (const p of t.pts) {
        const dx = p[0] - at[0];
        const dy = p[1] - at[1];
        if (
          Math.hypot(dx, dy) < ENDS_M
          && (dx * tx + dy * ty) * out > RIBBON_M * 4
        )
          on.add(line);
      }
    }
    return on.size < 2;
  }) as [boolean, boolean];
}

/**
 * Each non-yard track's service and other parts. Service: its extent in `service`, or all of a
 * connector (CONNECTOR_KINDS) whose connected group touches service track at two or more nodes.
 */
function servicePieces(
  segs: { props: SegmentProps; coords: LonLat[] }[],
  service: ServiceExtents,
): { props: SegmentProps; coords: LonLat[]; service: boolean }[] {
  const cums = segs.map((s) => cumulativeLengths(s.coords));
  const extent = segs.map((s) => service.get(s.props.id));
  const servedNodes = new Set<string>();
  segs.forEach((s, i) => {
    const e = extent[i];
    if (!e) return;
    if (e[0] <= END_M) servedNodes.add(s.props.from);
    if (e[1] >= cums[i]!.at(-1)! - END_M) servedNodes.add(s.props.to);
  });
  // Connected groups of connectors with no service of their own (a pocket and its sidings).
  const group = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]!));
  segs.forEach((s, i) => {
    parent[i] = i;
    if (extent[i] || !CONNECTOR_KINDS.has(s.props.kind)) return;
    for (const n of [s.props.from, s.props.to]) {
      const j = group.get(n);
      if (j === undefined) group.set(n, i);
      else parent[find(j)] = find(i);
    }
  });
  const touches = new Map<number, Set<string>>();
  segs.forEach((s, i) => {
    if (extent[i] || !CONNECTOR_KINDS.has(s.props.kind)) return;
    const r = find(i);
    const t = touches.get(r) ?? touches.set(r, new Set()).get(r)!;
    for (const n of [s.props.from, s.props.to])
      if (servedNodes.has(n)) t.add(n);
  });
  return segs.flatMap((s, i) => {
    const len = cums[i]!.at(-1)!;
    let e = extent[i];
    if (
      !e
      && CONNECTOR_KINDS.has(s.props.kind)
      && touches.get(find(i))!.size >= 2
    )
      e = [0, len];
    const piece = (a: number, b: number, inService: boolean) =>
      b - a < MIN_PIECE_M ?
        []
      : [
          {
            props: s.props,
            coords: sliceLine(s.coords, a, b, cums[i]),
            service: inService,
          },
        ];
    if (!e) return piece(0, len, false);
    return [
      ...piece(0, e[0], false),
      ...piece(e[0], e[1], true),
      ...piece(e[1], len, false),
    ];
  });
}

export function lineGeometry(
  tracks: InfraCollection,
  service: ServiceExtents,
): LineGeometry {
  const first = tracks.features.find((f) => f.geometry.type === "LineString");
  if (!first) return { type: "FeatureCollection", features: [] };
  // Metres around the network's first point (rounded to the millimetre, as Clipper works).
  const origin = (first.geometry.coordinates as LonLat[])[0]!;
  const base = localProjector(origin[1]);
  const [ox, oy] = base.toXY(origin);
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const proj = {
    toXY: (c: LonLat): XY => {
      const [x, y] = base.toXY(c);
      return [mm(x - ox), mm(y - oy)];
    },
    toLonLat: (x: number, y: number): LonLat => base.toLonLat(x + ox, y + oy),
  };
  const pieces = servicePieces(
    tracks.features.flatMap((f) => {
      if (f.properties.type !== "segment" || f.geometry.type !== "LineString")
        return [];
      const p = f.properties;
      if (!p.lines.length || p.works || p.kind === "yard") return [];
      return [{ props: p, coords: f.geometry.coordinates as LonLat[] }];
    }),
    service,
  ).map((t) => ({
    ...t,
    // West to east, so a shared track's first line is on its left.
    coords:
      t.coords.at(-1)![0] < t.coords[0]![0] ?
        [...t.coords].reverse()
      : t.coords,
  }));
  const all: Track[] = pieces
    .filter((t) => t.service)
    .map((t) => ({
      props: t.props,
      pts: densify(
        t.coords.map((c) => proj.toXY(c)),
        STEP_M,
      ),
    }));
  const main = all.filter((t) => t.props.kind === "main");
  const index = new SegmentIndex(main);
  const centres = main.map((t, i) => centreline(t, index, i));
  const toLonLat = (pts: XY[]): LonLat[] =>
    simplify(
      pts.map(([x, y]) => proj.toLonLat(x, y)),
      SIMPLIFY_M,
    ).map(([lon, lat]) => [round(lon, 6), round(lat, 6)]);

  const features: LineGeometry["features"] = [];

  // Corridors: where tracks of different lines run side by side, or a track is shared. Each
  // stretch of one is drawn as one shape whatever its tracks, cut lengthwise into one stripe per
  // line along a spine down its middle; at city zoom, the spine stroked in the same stripes.
  const r = RIBBON_M / 2;
  const keyOf = (t: Track) => t.props.lines.join("+");
  // Lines in a fixed order (those on shared track first, as listed there), for corridors whose
  // ends don't say which side each line leaves on.
  const lineOrder = [
    ...new Set([
      ...all
        .filter((t) => t.props.lines.length > 1)
        .flatMap((t) => t.props.lines),
      ...all.flatMap((t) => t.props.lines),
    ]),
  ];
  const corridorPieces = main.flatMap((t, i) => {
    const mask =
      t.props.lines.length > 1 ?
        t.pts.map(() => true)
      : t.pts.map(
          (p, k) =>
            index.partner(
              p,
              tangent(t.pts, k),
              i,
              BESIDE_M,
              (j) => keyOf(main[j]!) !== keyOf(t),
            ) !== undefined,
        );
    const c = centres[i]!;
    let k = 0;
    const out: { pts: XY[]; centre: XY[]; lines: string[] }[] = [];
    while (k < mask.length) {
      if (!mask[k]) {
        k++;
        continue;
      }
      const from = k;
      while (k < mask.length && mask[k]) k++;
      if (k - from > 1)
        out.push({
          pts: t.pts.slice(from, k),
          centre: c.slice(from, k),
          lines: t.props.lines,
        });
    }
    return out;
  });
  const allCorridorPts = corridorPieces.flatMap((p) => p.pts);
  const striped: { lines: string[]; spine: XY[] }[] = [];
  for (const st of joinStretches(
    spines(corridorPieces).map(({ spine, members }) => ({
      spine,
      tracks: members.map((i) => corridorPieces[i]!),
    })),
  )) {
    const lines = lineOrder.filter((l) =>
      st.tracks.some((t) => t.lines.includes(l)),
    );
    if (lines.length < 2 || lengthOf(st.spine) < MIN_STRIPED_M) continue;
    const spine = recentre(st.spine, allCorridorPts);
    striped.push({
      lines: bySide(lines, spine, all),
      spine: runOn(spine, endsRunOn(lines, spine, all), RIBBON_M * 4),
    });
  }
  // Every track of a stretch's lines beside its spine is part of it.
  const besideMask = new Map<Track, boolean[]>();
  const besideRuns = striped.map(({ lines, spine }) => {
    const near = besideLine(spine, BESIDE_M);
    return all.flatMap((t) => {
      if (!t.props.lines.some((l) => lines.includes(l))) return [];
      const m = t.pts.map(near);
      if (!m.some(Boolean)) return [];
      const prev = besideMask.get(t);
      besideMask.set(t, prev ? prev.map((v, k) => v || m[k]!) : m);
      return runs(t.pts, m, true);
    });
  });
  const stripes = new Map<string, Paths>();
  for (const [si, { lines, spine }] of striped.entries()) {
    const area = bands(besideRuns[si]!, r);
    lines.forEach((line, i) => {
      features.push({
        type: "Feature",
        properties: {
          type: "centre",
          line,
          lines,
          shared: true,
          stripe: i,
          stripes: lines.length,
        },
        geometry: { type: "LineString", coordinates: toLonLat(spine) },
      });
      const part = clip(
        ClipperLib.ClipType.ctIntersection,
        area,
        stripeArea(spine, i, lines.length, RIBBON_M * 4),
      );
      stripes.set(
        line,
        clip(ClipperLib.ClipType.ctUnion, stripes.get(line) ?? [], part),
      );
    });
  }
  // Elsewhere, each track in its (first) line's colour.
  main.forEach((t, i) => {
    const mask = besideMask.get(t);
    for (const part of mask ? runs(centres[i]!, mask, false) : [centres[i]!])
      features.push({
        type: "Feature",
        properties: {
          type: "centre",
          line: t.props.lines[0]!,
          lines: t.props.lines,
          shared: false,
        },
        geometry: { type: "LineString", coordinates: toLonLat(part) },
      });
  });
  const lines = [...new Set(all.flatMap((t) => t.props.lines))];
  // Lines are kept apart where their ribbons touch: each takes what earlier ones haven't.
  // Corridors first: lines' own track takes what they leave.
  let taken: Paths = clip(
    ClipperLib.ClipType.ctUnion,
    [...stripes.values()].flat(),
    [],
  );
  for (const line of lines) {
    const own = all.filter((t) => t.props.lines[0] === line);
    let area = clip(
      ClipperLib.ClipType.ctDifference,
      bands(
        own.map((t) => t.pts),
        r,
      ),
      taken,
    );
    taken = clip(ClipperLib.ClipType.ctUnion, taken, area);
    const stripe = stripes.get(line);
    if (stripe) area = clip(ClipperLib.ClipType.ctUnion, area, stripe);
    // Simplified before the last clean-up, not after: simplifying a finished ring can make it cross
    // itself, which draws as a darker sliver where the fill overlaps.
    const clean = ClipperLib.Clipper.SimplifyPolygons(
      area.map((path) => ClipperLib.JS.Lighten(path, SIMPLIFY_M * SCALE)),
      ClipperLib.PolyFillType.pftNonZero,
    );
    const coords = polygons(clean)
      .map((poly) =>
        poly
          .map((ring) =>
            ring.map(([x, y]): LonLat => {
              const [lon, lat] = proj.toLonLat(x, y);
              return [round(lon, 6), round(lat, 6)];
            }),
          )
          .filter((ring) => ring.length >= 4),
      )
      .filter((poly) => poly.length);
    if (!coords.length) continue;
    features.push({
      type: "Feature",
      properties: { type: "ribbon", line },
      geometry: { type: "MultiPolygon", coordinates: coords },
    });
  }
  for (const t of pieces)
    features.push({
      type: "Feature",
      properties: {
        type: "track",
        line: t.props.lines[0]!,
        lines: t.props.lines,
        kind: t.props.kind,
        service: t.service,
      },
      geometry: {
        type: "LineString",
        coordinates: simplify(t.coords, SIMPLIFY_M).map(([lon, lat]) => [
          round(lon, 6),
          round(lat, 6),
        ]),
      },
    });
  return { type: "FeatureCollection", features };
}
