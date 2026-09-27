// Split a route's shapes into frequent, limited-service and no-passenger sections, for drawing the
// latter two dotted (e.g. the 99 east of Commercial–Broadway, R5 trips along Boundary Road; the
// 99's run from its last drop-off to its layover stop). Data-driven: shapes are sampled onto a
// ~30 m grid and each cell counts the route's trips carrying passengers through it (both directions;
// GTFS pickup/drop-off types decide where passengers can be aboard). Cells no passenger trip covers
// are "empty"; sections well below the route's busiest cell are "limited".

import { cumulativeLengths, pointAlong, type LonLat } from '../geo.ts';
import { passengerLegs, type PlanPattern, type ServicePlan } from './types.ts';

export interface RouteSection {
  route: string;
  /** Limited service, or no passengers at all (see `empty`): drawn dotted. */
  limited: boolean;
  /** Buses run here but carry no passengers (e.g. to or from a layover stop). */
  empty: boolean;
  coords: LonLat[];
}

/** Distance ranges along a pattern's shape where passengers can be aboard. */
function passengerRanges(p: PlanPattern, shapeLength: number): [number, number][] {
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

type Cls = 'frequent' | 'limited' | 'empty';

export interface CoverageOptions {
  /** A section is limited if it carries less than this share of the route's busiest section. */
  limitedShare?: number;
  /** Sample spacing along shapes (m). */
  stepM?: number;
  /** Runs shorter than this don't change class (avoids flicker at stops and junctions) (m). */
  minRunM?: number;
}

const cellKey = (lon: number, lat: number) => `${Math.round(lon / 0.0004)},${Math.round(lat / 0.00027)}`;

export function routeSections(plan: ServicePlan, routeKeys: Set<string>, opts: CoverageOptions = {}): RouteSection[] {
  const share = opts.limitedShare ?? 0.25;
  const step = opts.stepM ?? 15;
  const minRun = opts.minRunM ?? 150;
  const trips = new Map<number, number>();
  for (const t of plan.trips) trips.set(t.pattern, (trips.get(t.pattern) ?? 0) + 1);

  const out: RouteSection[] = [];
  for (const route of routeKeys) {
    // Patterns without trips (e.g. superseded by a scenario) aren't drawn.
    const patterns = plan.patterns.filter((p) => p.route === route && (trips.get(p.id) ?? 0) > 0);
    // Samples per shape, and passenger-carrying trips per grid cell (each pattern counts a cell once).
    const samples = new Map<string, { lon: number; lat: number; d: number; cell: string }[]>();
    const cellTrips = new Map<string, number>();
    for (const p of patterns) {
      const coords = plan.shapes[p.shape] as LonLat[] | undefined;
      if (!coords || coords.length < 2) continue;
      let list = samples.get(p.shape);
      const cum = cumulativeLengths(coords);
      const total = cum[cum.length - 1]!;
      if (!list) {
        list = [];
        for (let d = 0; d <= total; d += step) {
          const q = pointAlong(coords, cum, d);
          list.push({ lon: q.lon, lat: q.lat, d, cell: cellKey(q.lon, q.lat) });
        }
        const q = pointAlong(coords, cum, total);
        list.push({ lon: q.lon, lat: q.lat, d: total, cell: cellKey(q.lon, q.lat) });
        samples.set(p.shape, list);
      }
      const ranges = passengerRanges(p, total);
      const carried = list.filter((s) => ranges.some(([a, b]) => s.d >= a - 1 && s.d <= b + 1));
      for (const cell of new Set(carried.map((s) => s.cell))) cellTrips.set(cell, (cellTrips.get(cell) ?? 0) + (trips.get(p.id) ?? 0));
    }
    const max = Math.max(0, ...cellTrips.values());
    const minSamples = Math.ceil(minRun / step);
    for (const list of samples.values()) {
      const cls: Cls[] = list.map((s) => {
        const n = cellTrips.get(s.cell) ?? 0;
        return n === 0 ? 'empty' : n < max * share ? 'limited' : 'frequent';
      });
      // Smooth frequent/limited: short runs take their neighbours' class. No-passenger runs come
      // straight from the timetable, so they're kept however short.
      let i = 0;
      while (i < cls.length) {
        let j = i;
        while (j < cls.length && cls[j] === cls[i]) j++;
        const isEdge = i === 0 || j === cls.length;
        if (j - i < minSamples && !isEdge && cls[i] !== 'empty') {
          const neighbour = cls[i - 1] !== 'empty' ? cls[i - 1]! : cls[j]!;
          if (neighbour !== 'empty') for (let k = i; k < j; k++) cls[k] = neighbour;
        }
        i = j;
      }
      // Emit runs (sharing the boundary point so lines join).
      let start = 0;
      for (let k = 1; k <= list.length; k++) {
        if (k < list.length && cls[k] === cls[start]) continue;
        const pts = list.slice(start, Math.min(list.length, k + 1)).map((s) => [s.lon, s.lat] as LonLat);
        if (pts.length >= 2) out.push({ route, limited: cls[start] !== 'frequent', empty: cls[start] === 'empty', coords: pts });
        start = k;
      }
    }
  }
  return out;
}
