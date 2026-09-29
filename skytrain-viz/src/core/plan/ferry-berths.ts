// Ferry berths and lanes (SeaBus): replaces a route's GTFS shapes with berth-to-berth paths along
// per-direction lanes. Every vessel uses the same berth pair all day. Runs at plan build time, so
// playback is unchanged. Patterns keep their ids (movement files reference pattern ids).

import { distM, localProjector, round, cumulativeLengths, type LonLat } from '../geo.ts';
import type { PlanTrip, ServicePlan } from './types.ts';

export interface FerryBerth {
  /** Vessel centre when berthed. */
  dock: LonLat;
  /** Slip axis pointing out to open water, degrees clockwise from north. */
  outBearing: number;
}

export interface FerryInfra {
  route: string;
  approachM: number;
  terminals: Record<string, { berths: Record<string, FerryBerth> }>;
  /** Keyed "from>to" by terminal name, in travel order, excluding the slip approaches. */
  lanes: Record<string, LonLat[]>;
}

export interface FerryConfig {
  /** Terminal → the berth every vessel uses. */
  pair: Record<string, string>;
}

/** A stop further than this from every berth of its nearest terminal isn't a terminal stop. */
const MAX_TERMINAL_M = 500;
/** Corner-cutting passes that smooth a berth-to-berth path. */
const SMOOTH_PASSES = 3;

export interface FerryBerthReport {
  /** Seconds two vessels are docked at the same berth at once (should be 0). */
  sharedBerthS: number;
  /** Shortest time between one vessel leaving a berth and the next arriving (s). */
  minBerthGapS: number;
}

export function applyFerryBerths(plan: ServicePlan, infra: FerryInfra, cfg: FerryConfig): FerryBerthReport {
  const report: FerryBerthReport = { sharedBerthS: 0, minBerthGapS: Infinity };
  const patterns = plan.patterns.filter((p) => p.route === infra.route);
  const oldShapes = new Set(patterns.map((p) => p.shape));

  const terminalOf = (stopIndex: number): string => {
    const s = plan.stops[stopIndex]!;
    let best: string | undefined;
    let bestD = Infinity;
    for (const [name, t] of Object.entries(infra.terminals)) {
      for (const b of Object.values(t.berths)) {
        const d = distM([s.lon, s.lat], b.dock);
        if (d < bestD) [best, bestD] = [name, d];
      }
    }
    if (!best || bestD > MAX_TERMINAL_M) throw new Error(`${infra.route}: stop ${s.name} is ${Math.round(bestD)} m from any berth`);
    return best;
  };

  const ends = new Map<number, { from: string; to: string }>();
  for (const p of patterns) {
    if (p.stops.length !== 2) throw new Error(`${infra.route}: pattern ${p.id} has intermediate stops`);
    const from = terminalOf(p.stops[0]!);
    const to = terminalOf(p.stops[1]!);
    ends.set(p.id, { from, to });
    const coords = berthPath(infra, from, cfg.pair[from]!, to, cfg.pair[to]!);
    const cum = cumulativeLengths(coords);
    p.shape = `${infra.route}:${from}-${cfg.pair[from]}>${to}-${cfg.pair[to]}`;
    p.dist = [0, Math.round(cum[cum.length - 1]!)];
    plan.shapes[p.shape] = coords;
  }
  for (const id of oldShapes) if (!plan.patterns.some((p) => p.shape === id)) delete plan.shapes[id];

  // Check the shared berths: per service, when each vessel (block) lies docked at each terminal.
  const blocks = new Map<string, PlanTrip[]>();
  for (const t of plan.trips) {
    if (!ends.has(t.pattern) || !t.block) continue;
    const key = `${t.service}|${t.block}`;
    let list = blocks.get(key);
    if (!list) blocks.set(key, (list = []));
    list.push(t);
  }
  const docked = new Map<string, [number, number][]>();
  for (const [key, trips] of blocks) {
    trips.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < trips.length; i++) {
      const terminal = ends.get(trips[i]!.pattern)!.to;
      if (ends.get(trips[i + 1]!.pattern)!.from !== terminal) continue;
      const k = `${key.split('|')[0]}|${terminal}`;
      let list = docked.get(k);
      if (!list) docked.set(k, (list = []));
      list.push([trips[i]!.start + trips[i]!.arr[trips[i]!.arr.length - 1]!, trips[i + 1]!.start]);
    }
  }
  for (const list of docked.values()) {
    list.sort((a, b) => a[0] - b[0]);
    let free = -Infinity;
    for (const [t0, t1] of list) {
      if (t0 < free) report.sharedBerthS += Math.min(free, t1) - t0;
      else if (free > -Infinity) report.minBerthGapS = Math.min(report.minBerthGapS, t0 - free);
      free = Math.max(free, t1);
    }
  }
  return report;
}

/** Dock → slip approach → lane → slip approach → dock, with corners smoothed. */
export function berthPath(infra: FerryInfra, from: string, fromBerth: string, to: string, toBerth: string): LonLat[] {
  const a = infra.terminals[from]?.berths[fromBerth];
  const b = infra.terminals[to]?.berths[toBerth];
  const lane = infra.lanes[`${from}>${to}`];
  if (!a || !b || !lane) throw new Error(`${infra.route}: no berth or lane for ${from}-${fromBerth} > ${to}-${toBerth}`);
  const proj = localProjector((a.dock[1] + b.dock[1]) / 2);
  const out = (berth: FerryBerth): LonLat => {
    const [x, y] = proj.toXY(berth.dock);
    const r = (berth.outBearing * Math.PI) / 180;
    return proj.toLonLat(x + infra.approachM * Math.sin(r), y + infra.approachM * Math.cos(r));
  };
  let pts = [a.dock, out(a), ...lane, out(b), b.dock].map(proj.toXY);
  // Chaikin corner cutting, keeping both docks fixed.
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next: [number, number][] = [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[i + 1]!;
      if (i > 0) next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
      if (i + 2 < pts.length) next.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return pts.map(([x, y]) => {
    const [lon, lat] = proj.toLonLat(x, y);
    return [round(lon, 6), round(lat, 6)] as LonLat;
  });
}
