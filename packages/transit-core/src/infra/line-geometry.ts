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
//   polygon per line (the shared Expo/Millennium section cut along its centreline, one line each side).
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
    /** Shared by two lines: drawn west to east, the first line on the left half. */
    shared: boolean;
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
  /** The nearest point within PARTNER_M on a parallel track other than `self`. */
  partner(p: XY, t: XY, self: number): XY | undefined {
    const cx = Math.floor(p[0] / PARTNER_M);
    const cy = Math.floor(p[1] / PARTNER_M);
    let best: XY | undefined;
    let bestD = PARTNER_M;
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++)
        for (const [ti, k] of this.grid.get(`${i},${j}`) ?? []) {
          if (ti === self) continue;
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

/** The area left of a west-to-east polyline, out to `w` metres (and `w` beyond each end). */
function leftStrip(pts: XY[], w: number): XY[][] {
  if (pts.length < 2) return [];
  const t0 = tangent(pts, 0);
  const tn = tangent(pts, pts.length - 1);
  const line: XY[] = [
    [pts[0]![0] - t0[0] * w, pts[0]![1] - t0[1] * w],
    ...pts,
    [pts.at(-1)![0] + tn[0] * w, pts.at(-1)![1] + tn[1] * w],
  ];
  const out: XY[][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    const nx = (-dy / d) * w;
    const ny = (dx / d) * w;
    out.push([a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]);
  }
  return out;
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

  const features: LineGeometry["features"] = main.map((t, i) => ({
    type: "Feature",
    properties: {
      type: "centre",
      line: t.props.lines[0]!,
      lines: t.props.lines,
      shared: t.props.lines.length > 1,
    },
    geometry: { type: "LineString", coordinates: toLonLat(centres[i]!) },
  }));

  // Ribbons: shared tracks split along their centrelines; each line's own tracks around them.
  const r = RIBBON_M / 2;
  const shared = all.filter((t) => t.props.lines.length > 1);
  const sharedArea = bands(
    shared.map((t) => t.pts),
    r,
  );
  const left = clip(
    ClipperLib.ClipType.ctUnion,
    main.flatMap((t, i) =>
      t.props.lines.length > 1 ?
        leftStrip(centres[i]!, RIBBON_M * 4).map(toPath)
      : [],
    ),
    [],
  );
  const halves = new Map<string, Paths>();
  const sharedLines = shared[0]?.props.lines ?? [];
  if (sharedLines.length > 1) {
    halves.set(
      sharedLines[0]!,
      clip(ClipperLib.ClipType.ctIntersection, sharedArea, left),
    );
    halves.set(
      sharedLines[1]!,
      clip(ClipperLib.ClipType.ctDifference, sharedArea, left),
    );
  }
  const lines = [...new Set(all.flatMap((t) => t.props.lines))];
  // Lines are kept apart where their ribbons touch: each takes what earlier ones haven't.
  let taken: Paths = sharedArea;
  for (const line of lines) {
    const own = all.filter(
      (t) => t.props.lines.length === 1 && t.props.lines[0] === line,
    );
    let area = clip(
      ClipperLib.ClipType.ctDifference,
      bands(
        own.map((t) => t.pts),
        r,
      ),
      taken,
    );
    taken = clip(ClipperLib.ClipType.ctUnion, taken, area);
    const half = halves.get(line);
    if (half) area = clip(ClipperLib.ClipType.ctUnion, area, half);
    const coords = polygons(area)
      .map((poly) =>
        poly.map((ring) => toLonLat(ring)).filter((ring) => ring.length >= 4),
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
