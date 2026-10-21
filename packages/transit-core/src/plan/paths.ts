// Patterns' paths over the lines drawn for them (packages/transit-core/DESIGN.md#published-plans):
// for each pattern, in order, the features of the plan's tiles it runs along and where along its
// shape it does. A combined route (schedule/shared-segment.ts) is drawn over the features of its
// stretch. Bus patterns run along corridors (recorded as the corridors are built, from the road
// pieces each pattern's matched shape runs along, in order); SkyTrain's run along the pieces of its
// line geometry (infra/line-geometry.ts), matched to their shapes when the plan's tiles are made,
// which number those pieces.

import {
  cumulativeLengths,
  localProjector,
  pointAlong,
  projectOnto,
  type LonLat,
} from "../geo.ts";
import type { LineGeometry } from "../infra/line-geometry.ts";
import type { BuiltCorridor, BuiltStep } from "./corridors.ts";
import type { PathStep, PatternPath, ServicePlan } from "./types.ts";

/**
 * A corridor (or a piece of SkyTrain's line) is drawn whole, so a pattern's stretch is drawn over
 * one where it runs along at least this much of it (m), or half of it (`segmentSteps`). A pass
 * along less of one (round a station's bus loop, back over the street it came in on) gets no step:
 * it could never count. A presentation choice.
 */
export const MIN_OVERLAP_M = 100;

/**
 * Bus patterns' paths over the plan's corridors, detailed and overview (`buildCorridors`,
 * `mergeCarriageways`), numbered as the corridors are: their index in the plan.
 */
export function corridorPaths(
  detailed: readonly BuiltCorridor[],
  detailedPaths: ReadonlyMap<number, readonly BuiltStep[]>,
  overview: readonly BuiltCorridor[],
  overviewPaths: ReadonlyMap<number, readonly BuiltStep[]>,
): Map<number, PatternPath> {
  const steps = (
    corridors: readonly BuiltCorridor[],
    paths: ReadonlyMap<number, readonly BuiltStep[]>,
  ) => {
    const index = new Map(corridors.map((c, i) => [c, i]));
    const length = new Map(
      corridors.map((c) => [
        c,
        c.coords.length < 2 ? 0 : cumulativeLengths(c.coords).at(-1)!,
      ]),
    );
    return new Map(
      [...paths].map(([p, list]) => [
        p,
        list.flatMap((st): PathStep[] => {
          const id = index.get(st.corridor);
          const covers = st.to - st.from;
          return (
              id === undefined
                || covers
                  < Math.min(MIN_OVERLAP_M, length.get(st.corridor)! / 2)
            ) ?
              []
            : [[id, Math.round(st.from), Math.round(st.to)]];
        }),
      ]),
    );
  };
  const d = steps(detailed, detailedPaths);
  const o = steps(overview, overviewPaths);
  const out = new Map<number, PatternPath>();
  for (const p of new Set([...d.keys(), ...o.keys()]))
    out.set(p, { detailed: d.get(p) ?? [], overview: o.get(p) ?? [] });
  return out;
}

/**
 * A piece of line runs along a pattern where every point of it is within this distance of the
 * pattern's shape (m): GTFS's SkyTrain shapes follow the guideway, a few metres off its centre.
 */
const RAIL_MATCH_M = 30;
/** A piece's points are checked this far apart (m). */
const RAIL_SAMPLE_M = 25;

/**
 * SkyTrain patterns' paths over the pieces of its line geometry: each centreline and service track
 * (by its index in `lines`, its feature id in the plan's tiles) of the pattern's line lying along
 * the pattern's shape, from and to where it does.
 */
export function railPaths(
  plan: ServicePlan,
  lines: LineGeometry,
): Map<number, PathStep[]> {
  const out = new Map<number, PathStep[]>();
  const rail = new Set(
    plan.routes.filter((r) => r.mode === "skytrain").map((r) => r.key),
  );
  // Each candidate piece: its id, lines, sampled points and bounding box.
  const pieces = lines.features.flatMap((f, id) => {
    const p = f.properties;
    if (p.type === "ribbon" || (p.type === "track" && !p.service)) return [];
    const coords = f.geometry.coordinates as LonLat[];
    const cum = cumulativeLengths(coords);
    const len = cum.at(-1)!;
    const n = Math.max(1, Math.ceil(len / RAIL_SAMPLE_M));
    const pts = Array.from({ length: n + 1 }, (_, k): LonLat => {
      const q = pointAlong(coords, cum, (len * k) / n);
      return [q.lon, q.lat];
    });
    return [{ id, lines: new Set(p.lines), pts, box: boxOf(pts) }];
  });
  for (const pattern of plan.patterns) {
    if (!rail.has(pattern.route)) continue;
    const shape = plan.shapes[pattern.shape] as LonLat[] | undefined;
    if (!shape || shape.length < 2) continue;
    const cum = cumulativeLengths(shape);
    const box = grow(boxOf(shape), RAIL_MATCH_M);
    const steps: PathStep[] = [];
    for (const piece of pieces) {
      if (!piece.lines.has(pattern.route) || !overlaps(box, piece.box))
        continue;
      let from = Infinity;
      let to = -Infinity;
      let along = true;
      for (const pt of piece.pts) {
        const q = projectOnto(shape, cum, pt);
        if (q.offset > RAIL_MATCH_M) {
          along = false;
          break;
        }
        from = Math.min(from, q.along);
        to = Math.max(to, q.along);
      }
      if (along) steps.push([piece.id, Math.round(from), Math.round(to)]);
    }
    steps.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (steps.length) out.set(pattern.id, steps);
  }
  return out;
}

type Box = [number, number, number, number];

function boxOf(pts: readonly LonLat[]): Box {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [w, s, e, n];
}

/** A box grown by `m` metres each way. */
function grow([w, s, e, n]: Box, m: number): Box {
  const { toLonLat } = localProjector(s);
  const [dx, dy] = toLonLat(m, m);
  return [w - dx, s - dy, e + dx, n + dy];
}

function overlaps(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
