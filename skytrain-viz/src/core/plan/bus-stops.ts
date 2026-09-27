// Map markers for express bus stops: one per location (GTFS has a stop per direction, e.g.
// "Eastbound W Broadway @ Alma St" and "Westbound W Broadway @ Alma St"), labelled by cross street
// or exchange name, leaving out stops at stations (the station marker already covers them).

import { distM, type LonLat } from '../geo.ts';
import type { ServicePlan } from './types.ts';

export interface BusStopMarker {
  name: string;
  lon: number;
  lat: number;
  /** Route keys serving the stop. */
  routes: string[];
}

/** Same-named stops within this distance merge into one marker (far-side pairs can be ~200 m apart) (m). */
const MERGE_M = 250;
/** Stops within this distance of a station aren't shown (m). */
const STATION_M = 200;

/** Marker label for a GTFS stop name, or undefined for a station bay or a layover. */
export function busStopLabel(name: string): string | undefined {
  const [before = '', after = ''] = name.split('@').map((s) => s.replace(/\s+/g, ' ').trim());
  if (/\bStation$/i.test(before) || /^Layover$/i.test(after)) return undefined;
  // Exchanges and loops: "UBC Exchange @ Bay 7", "Haney Place @ Bay 1", "Phibbs Exchange @".
  if (/^(Bay\b|Unload)/i.test(after) || !after) return before;
  // Street stops: the cross street ("Eastbound W Broadway @ Alma St" → "Alma St").
  return after.replace(/[-\s]+$/, '');
}

export function busStopMarkers(plan: ServicePlan): BusStopMarker[] {
  const busRoutes = new Set(plan.routes.filter((r) => r.kind === 'bus').map((r) => r.key));
  const used = new Set(plan.trips.map((t) => t.pattern));
  const routesAt = new Map<number, Set<string>>();
  for (const p of plan.patterns) {
    if (!busRoutes.has(p.route) || !used.has(p.id)) continue;
    for (const si of p.stops) {
      if (!routesAt.has(si)) routesAt.set(si, new Set());
      routesAt.get(si)!.add(p.route);
    }
  }
  const stations: LonLat[] = plan.stations.map((s) => [s.lon, s.lat]);
  const groups: { name: string; pts: LonLat[]; routes: Set<string> }[] = [];
  for (const [si, routes] of routesAt) {
    const s = plan.stops[si]!;
    const name = busStopLabel(s.name);
    const at: LonLat = [s.lon, s.lat];
    if (!name || stations.some((st) => distM(st, at) < STATION_M)) continue;
    const g = groups.find((x) => x.name === name && x.pts.some((q) => distM(q, at) < MERGE_M));
    if (g) {
      g.pts.push(at);
      for (const r of routes) g.routes.add(r);
    } else groups.push({ name, pts: [at], routes: new Set(routes) });
  }
  return groups.map((g) => ({
    name: g.name,
    lon: g.pts.reduce((a, p) => a + p[0], 0) / g.pts.length,
    lat: g.pts.reduce((a, p) => a + p[1], 0) / g.pts.length,
    routes: [...g.routes].sort(),
  }));
}
