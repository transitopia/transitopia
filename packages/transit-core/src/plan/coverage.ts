// Split a route's shapes into frequent, limited-service and no-passenger sections, for drawing the
// latter two dotted (e.g. the 99 east of Commercial–Broadway, R5 trips along Boundary Road; the
// 99's run from its last drop-off to its layover stop). Data-driven: shapes are sampled onto a
// ~30 m grid and each cell counts the route's trips carrying passengers through it (both directions;
// GTFS pickup/drop-off types decide where passengers can be aboard). Cells no passenger trip covers
// are "empty"; sections well below the route's busiest cell are "limited".

import { cumulativeLengths, distM, pointAlong, type LonLat } from "../geo.ts";
import { passengerLegs, type PlanPattern, type ServicePlan } from "./types.ts";

export interface RouteSection {
  route: string;
  /** Limited service, or no passengers at all (see `empty`): drawn dotted. */
  limited: boolean;
  /** Buses run here but carry no passengers (e.g. to or from a layover stop). */
  empty: boolean;
  coords: LonLat[];
}

/** Distance ranges along a pattern's shape where passengers can be aboard. */
function passengerRanges(
  p: PlanPattern,
  shapeLength: number,
): [number, number][] {
  const legs = passengerLegs(p);
  const out: [number, number][] = [];
  legs.forEach((carried, i) => {
    if (!carried) return;
    // Shape beyond the first/last stop belongs to the adjacent leg.
    const from = i === 0 ? 0 : p.dist[i]!;
    const to = i === legs.length - 1 ? shapeLength : p.dist[i + 1]!;
    const last = out[out.length - 1];
    if (last && last[1] >= from) last[1] = to;
    else out.push([from, to]);
  });
  return out;
}

type Cls = "frequent" | "limited" | "empty";
/** Where lines overlap, more service wins. */
const RANK: Record<Cls, number> = { frequent: 2, limited: 1, empty: 0 };

/** Drawn segments of one route, in a coarse grid (local metres), for "already drawn here?" tests. */
class SegmentGrid {
  private cells = new Map<string, [number, number, number, number][]>();
  private static readonly CELL = 25;
  private kx = Math.cos((49.25 * Math.PI) / 180) * 111_320;
  xy(p: LonLat): [number, number] {
    return [p[0] * this.kx, p[1] * 111_320];
  }
  add(a: LonLat, b: LonLat): void {
    const [ax, ay] = this.xy(a);
    const [bx, by] = this.xy(b);
    const keys = new Set([
      this.key(ax, ay),
      this.key(bx, by),
      this.key((ax + bx) / 2, (ay + by) / 2),
    ]);
    for (const k of keys)
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push([
        ax,
        ay,
        bx,
        by,
      ]);
  }
  /** Distance (m) from p to the nearest drawn segment, up to about one cell. */
  near(p: LonLat): number {
    const [x, y] = this.xy(p);
    const cx = Math.floor(x / SegmentGrid.CELL);
    const cy = Math.floor(y / SegmentGrid.CELL);
    let best = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const [ax, ay, bx, by] of this.cells.get(`${cx + i},${cy + j}`)
          ?? []) {
          const dx = bx - ax;
          const dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const f =
            l2 > 0 ?
              Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
            : 0;
          best = Math.min(best, Math.hypot(ax + dx * f - x, ay + dy * f - y));
        }
    return best;
  }
  private key(x: number, y: number): string {
    return `${Math.floor(x / SegmentGrid.CELL)},${Math.floor(y / SegmentGrid.CELL)}`;
  }
}

export interface CoverageOptions {
  /** A section is limited if it carries less than this share of the route's busiest section. */
  limitedShare?: number;
  /** Sample spacing along shapes (m). */
  stepM?: number;
  /** Runs shorter than this don't change class (avoids flicker at stops and junctions) (m). */
  minRunM?: number;
  /**
   * A no-passenger stretch within this of a line already drawn for the route is merged into it (m):
   * e.g. the 99's arrival and departure shapes on N Grandview Hwy, one street drawn ~7 m apart as
   * two dotted lines. Only no-passenger stretches are merged: merging every line also merged the
   * two roadways of divided streets (some < 10 m apart), paled lines where two directions used to
   * overlap, and left gaps (compared at 10 places, 2026-09-26).
   */
  mergeM?: number;
  /** A point off its own passenger legs still carries passengers if a passenger line of the route is this close (m). */
  emptyNearM?: number;
}

const cellKey = (lon: number, lat: number) =>
  `${Math.round(lon / 0.0004)},${Math.round(lat / 0.00027)}`;

export function routeSections(
  plan: ServicePlan,
  routeKeys: Set<string>,
  opts: CoverageOptions = {},
): RouteSection[] {
  const share = opts.limitedShare ?? 0.25;
  const step = opts.stepM ?? 15;
  const minRun = opts.minRunM ?? 150;
  const mergeM = opts.mergeM ?? 10;
  const emptyNearM = opts.emptyNearM ?? 15;
  const trips = new Map<number, number>();
  for (const t of plan.trips)
    trips.set(t.pattern, (trips.get(t.pattern) ?? 0) + 1);

  const out: RouteSection[] = [];
  for (const route of routeKeys) {
    // Patterns without trips (e.g. superseded by a scenario) aren't drawn.
    const patterns = plan.patterns.filter(
      (p) => p.route === route && (trips.get(p.id) ?? 0) > 0,
    );
    // Samples per shape (every `step` metres plus every vertex, so identical shapes give identical
    // lines, corners included), and passenger-carrying trips per grid cell (each pattern counts a
    // cell once). `carried`: some pattern on this shape can have passengers aboard here.
    const samples = new Map<
      string,
      { lon: number; lat: number; d: number; cell: string; carried: boolean }[]
    >();
    const cellTrips = new Map<string, number>();
    const carriedGrid = new SegmentGrid();
    for (const p of patterns) {
      const coords = plan.shapes[p.shape] as LonLat[] | undefined;
      if (!coords || coords.length < 2) continue;
      let list = samples.get(p.shape);
      const cum = cumulativeLengths(coords);
      const total = cum[cum.length - 1]!;
      if (!list) {
        const ds: number[] = [];
        for (let d = 0; d < total; d += step) ds.push(d);
        ds.push(...cum, total);
        ds.sort((a, b) => a - b);
        list = [];
        for (const d of ds) {
          if (list.length && d - list[list.length - 1]!.d < 1) continue;
          const q = pointAlong(coords, cum, d);
          list.push({
            lon: q.lon,
            lat: q.lat,
            d,
            cell: cellKey(q.lon, q.lat),
            carried: false,
          });
        }
        samples.set(p.shape, list);
      }
      const ranges = passengerRanges(p, total);
      const carried = list.filter((s) =>
        ranges.some(([a, b]) => s.d >= a - 1 && s.d <= b + 1),
      );
      for (const s of carried) {
        s.carried = true;
        // For "a passenger line is close by", leave out the tips of passenger stretches: otherwise
        // the line itself (and identical variants) ran solid past a last drop-off.
        const inner = ranges.some(
          ([a, b]) =>
            s.d >= (a > 0 ? a + emptyNearM : a)
            && s.d <= (b < total ? b - emptyNearM : b),
        );
        if (inner) carriedGrid.add([s.lon, s.lat], [s.lon, s.lat]);
      }
      for (const cell of new Set(carried.map((s) => s.cell)))
        cellTrips.set(
          cell,
          (cellTrips.get(cell) ?? 0) + (trips.get(p.id) ?? 0),
        );
    }
    const max = Math.max(0, ...cellTrips.values());
    const minSamples = Math.ceil(minRun / step);
    // Classified runs of every shape, merged below.
    const runs: { cls: Cls; pts: LonLat[]; weight: number }[] = [];
    const shapeTrips = new Map<string, number>();
    for (const p of patterns)
      shapeTrips.set(
        p.shape,
        (shapeTrips.get(p.shape) ?? 0) + (trips.get(p.id) ?? 0),
      );
    for (const [shape, list] of samples) {
      const cls: Cls[] = list.map((s) => {
        // No passengers: judged per point (the grid is too coarse; it ran solid lines a cell past
        // a last drop-off), from this shape's legs or any passenger line of the route close by.
        if (!s.carried && carriedGrid.near([s.lon, s.lat]) > emptyNearM)
          return "empty";
        const n = cellTrips.get(s.cell) ?? 0;
        return n === 0 || n < max * share ? "limited" : "frequent";
      });
      // Smooth frequent/limited: short runs take their neighbours' class. No-passenger runs come
      // straight from the timetable, so they're kept however short.
      let i = 0;
      while (i < cls.length) {
        let j = i;
        while (j < cls.length && cls[j] === cls[i]) j++;
        const isEdge = i === 0 || j === cls.length;
        if (j - i < minSamples && !isEdge && cls[i] !== "empty") {
          const neighbour = cls[i - 1] !== "empty" ? cls[i - 1]! : cls[j]!;
          if (neighbour !== "empty")
            for (let k = i; k < j; k++) cls[k] = neighbour;
        }
        i = j;
      }
      // Runs (sharing the boundary point so lines join).
      let start = 0;
      for (let k = 1; k <= list.length; k++) {
        if (k < list.length && cls[k] === cls[start]) continue;
        const pts = list
          .slice(start, Math.min(list.length, k + 1))
          .map((s) => [s.lon, s.lat] as LonLat);
        if (pts.length >= 2)
          runs.push({
            cls: cls[start]!,
            pts,
            weight: shapeTrips.get(shape) ?? 0,
          });
        start = k;
      }
    }
    // Passenger lines are drawn as they are. No-passenger runs skip what lies within mergeM of lines
    // already drawn, keeping one point of overlap so lines still join. Runs continuing from a
    // passenger line (e.g. after a last drop-off) go first, then runs leading into one (before a first
    // pickup), then the rest, busiest shapes first: so where e.g. a route's arrival and departure
    // layover runs overlap, the arrival run stays attached to its passenger line and the departure
    // run is trimmed to where it leaves it.
    const grid = new SegmentGrid();
    const passenger = runs
      .filter((r) => r.cls !== "empty")
      .sort(
        (a, b) =>
          RANK[b.cls] - RANK[a.cls]
          || b.weight - a.weight
          || b.pts.length - a.pts.length,
      );
    for (const run of passenger)
      for (let k = 1; k < run.pts.length; k++)
        grid.add(run.pts[k - 1]!, run.pts[k]!);
    const attach = (r: (typeof runs)[number]) =>
      grid.near(r.pts[0]!) <= 3 ? 0
      : grid.near(r.pts[r.pts.length - 1]!) <= 3 ? 1
      : 2;
    const empties = runs
      .filter((r) => r.cls === "empty")
      .map((r) => ({ r, a: attach(r) }))
      .sort(
        (x, y) =>
          x.a - y.a
          || y.r.weight - x.r.weight
          || y.r.pts.length - x.r.pts.length,
      );
    for (const run of passenger)
      out.push({
        route,
        limited: run.cls !== "frequent",
        empty: false,
        coords: run.pts,
      });
    for (const { r: run, a } of empties) {
      const covered = run.pts.map((p) => grid.near(p) <= mergeM);
      // Never trim the first metres off the end attached to a passenger line (that's the join).
      const keepFrom = (k0: number, dk: number) => {
        for (
          let k = k0;
          k >= 0
          && k < run.pts.length
          && distM(run.pts[k]!, run.pts[k0]!) <= mergeM;
          k += dk
        )
          covered[k] = false;
      };
      if (a === 0) keepFrom(0, 1);
      if (a === 1) keepFrom(run.pts.length - 1, -1);
      let i = 0;
      while (i < run.pts.length) {
        if (covered[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < run.pts.length && !covered[j]) j++;
        const pts = run.pts.slice(
          Math.max(0, i - 1),
          Math.min(run.pts.length, j + 1),
        );
        if (pts.length >= 2) {
          out.push({
            route,
            limited: run.cls !== "frequent",
            empty: run.cls === "empty",
            coords: pts,
          });
          for (let k = 1; k < pts.length; k++) grid.add(pts[k - 1]!, pts[k]!);
        }
        i = j;
      }
    }
  }
  return out;
}
