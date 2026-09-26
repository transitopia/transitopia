// Split a route's shapes into frequent and limited-service sections, for drawing limited sections
// dashed (e.g. the 99 east of Commercial–Broadway, R5 trips along Boundary Road). Data-driven:
// shapes are sampled onto a ~30 m grid and each cell counts the route's trips through it (both
// directions); sections well below the route's busiest cell are "limited".

import { cumulativeLengths, pointAlong, type LonLat } from '../geo.ts';
import type { ServicePlan } from './types.ts';

export interface RouteSection {
  route: string;
  limited: boolean;
  coords: LonLat[];
}

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
    // Samples per shape, and trips per grid cell (each pattern counts a cell once).
    const samples = new Map<string, { lon: number; lat: number; cell: string }[]>();
    const cellTrips = new Map<string, number>();
    for (const p of patterns) {
      const coords = plan.shapes[p.shape] as LonLat[] | undefined;
      if (!coords || coords.length < 2) continue;
      let list = samples.get(p.shape);
      if (!list) {
        const cum = cumulativeLengths(coords);
        const total = cum[cum.length - 1]!;
        list = [];
        for (let d = 0; d <= total; d += step) {
          const q = pointAlong(coords, cum, d);
          list.push({ lon: q.lon, lat: q.lat, cell: cellKey(q.lon, q.lat) });
        }
        const q = pointAlong(coords, cum, total);
        list.push({ lon: q.lon, lat: q.lat, cell: cellKey(q.lon, q.lat) });
        samples.set(p.shape, list);
      }
      for (const cell of new Set(list.map((s) => s.cell))) cellTrips.set(cell, (cellTrips.get(cell) ?? 0) + (trips.get(p.id) ?? 0));
    }
    const max = Math.max(0, ...cellTrips.values());
    for (const list of samples.values()) {
      const cls = list.map((s) => (cellTrips.get(s.cell) ?? 0) < max * share);
      // Smooth: short runs take their neighbours' class.
      const minSamples = Math.ceil(minRun / step);
      let i = 0;
      while (i < cls.length) {
        let j = i;
        while (j < cls.length && cls[j] === cls[i]) j++;
        const isEdge = i === 0 || j === cls.length;
        if (j - i < minSamples && !isEdge) for (let k = i; k < j; k++) cls[k] = !cls[k];
        i = j;
      }
      // Emit runs (sharing the boundary point so lines join).
      let start = 0;
      for (let k = 1; k <= list.length; k++) {
        if (k < list.length && cls[k] === cls[start]) continue;
        const pts = list.slice(start, Math.min(list.length, k + 1)).map((s) => [s.lon, s.lat] as LonLat);
        if (pts.length >= 2) out.push({ route, limited: cls[start]!, coords: pts });
        start = k;
      }
    }
  }
  return out;
}
