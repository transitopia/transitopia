// Map markers for express bus stops, leaving out stops at stations (the station marker covers them):
// - a tick per GTFS stop (one per direction), jutting from the route line toward the side of the
//   street the stop is on, so opposite stops make a "+";
// - a label per location (both directions merged), by cross street or exchange name.

import { cumulativeLengths, distM, localProjector, pointAlong, type LonLat } from '../geo.ts';
import type { ServicePlan } from './types.ts';

export interface BusStopMarker {
  name: string;
  /** Base of one of its ticks, on the route line. */
  lon: number;
  lat: number;
  /** That tick's direction: the label goes beyond its end. */
  bearing: number;
  /** Route keys serving the stop. */
  routes: string[];
}

/** Same-named stops whose ticks are within this distance share a label (far-side pairs can be ~200 m apart) (m). */
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

export interface BusStopTick {
  route: string;
  /** Label (cross street or exchange). */
  name: string;
  /** Point on the route line. */
  lon: number;
  lat: number;
  /** Direction the tick points, toward the stop's side of the street (degrees clockwise from north). */
  bearing: number;
}

/** A stop closer than this to the route line is assumed to be on the right, as traffic drives (m). */
const ON_LINE_M = 2;

function stationPoints(plan: ServicePlan): LonLat[] {
  return plan.stations.map((s) => [s.lon, s.lat]);
}

function shownAt(name: string, at: LonLat, stations: LonLat[]): string | undefined {
  const label = busStopLabel(name);
  return label && !stations.some((st) => distM(st, at) < STATION_M) ? label : undefined;
}

export function busStopTicks(plan: ServicePlan): BusStopTick[] {
  const busRoutes = new Set(plan.routes.filter((r) => r.kind === 'bus').map((r) => r.key));
  const used = new Set(plan.trips.map((t) => t.pattern));
  const stations = stationPoints(plan);
  const cums = new Map<string, Float64Array>();
  const seen = new Set<string>();
  const out: BusStopTick[] = [];
  for (const p of plan.patterns) {
    if (!busRoutes.has(p.route) || !used.has(p.id)) continue;
    const shape = plan.shapes[p.shape] as LonLat[] | undefined;
    if (!shape || shape.length < 2) continue;
    let cum = cums.get(p.shape);
    if (!cum) cums.set(p.shape, (cum = cumulativeLengths(shape)));
    p.stops.forEach((si, i) => {
      const s = plan.stops[si]!;
      const key = `${s.id}|${p.route}`;
      if (seen.has(key)) return;
      seen.add(key);
      const at: LonLat = [s.lon, s.lat];
      const name = shownAt(s.name, at, stations);
      if (!name) return;
      const q = pointAlong(shape, cum!, p.dist[i]!);
      // Which side of the direction of travel is the stop on?
      const proj = localProjector(q.lat);
      const [qx, qy] = proj.toXY([q.lon, q.lat]);
      const [sx, sy] = proj.toXY(at);
      const tx = Math.sin((q.bearing * Math.PI) / 180);
      const ty = Math.cos((q.bearing * Math.PI) / 180);
      const cross = tx * (sy - qy) - ty * (sx - qx); // > 0: stop is left of travel
      const left = Math.hypot(sx - qx, sy - qy) >= ON_LINE_M && cross > 0;
      out.push({ route: p.route, name, lon: q.lon, lat: q.lat, bearing: (q.bearing + (left ? 270 : 90)) % 360 });
    });
  }
  return out;
}

export function busStopMarkers(plan: ServicePlan): BusStopMarker[] {
  const groups: { name: string; ticks: BusStopTick[]; routes: Set<string> }[] = [];
  for (const t of busStopTicks(plan)) {
    const at: LonLat = [t.lon, t.lat];
    const g = groups.find((x) => x.name === t.name && x.ticks.some((q) => distM([q.lon, q.lat], at) < MERGE_M));
    if (g) {
      g.ticks.push(t);
      g.routes.add(t.route);
    } else groups.push({ name: t.name, ticks: [t], routes: new Set([t.route]) });
  }
  // Label at the first tick, on its side of the line.
  return groups.map((g) => ({ name: g.name, lon: g.ticks[0]!.lon, lat: g.ticks[0]!.lat, bearing: g.ticks[0]!.bearing, routes: [...g.routes].sort() }));
}
