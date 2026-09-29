// Ferry berths and lanes (SeaBus): replaces a route's GTFS shapes with berth-to-berth paths along
// per-direction lanes, and assigns each vessel (GTFS block) a berth pair for the day. Runs at plan
// build time, so playback is unchanged: trips just point at berth-specific patterns.
//
// Pattern ids of other routes stay stable (movement files reference them): each original pattern
// becomes its first pair's variant in place, and other pairs' variants are appended.

import { cumulativeLengths, distM, localProjector, round, type LonLat } from '../geo.ts';
import type { PlanPattern, PlanTrip, ServicePlan } from './types.ts';

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
  /** Terminal → berth, in order of preference. */
  pairs: Record<string, string>[];
}

/** A stop further than this from every berth of its nearest terminal isn't a terminal stop. */
const MAX_TERMINAL_M = 500;
/** Corner-cutting passes that smooth a berth-to-berth path. */
const SMOOTH_PASSES = 3;

export interface FerryBerthReport {
  /** service → pair index → number of vessels (blocks). */
  vessels: Map<string, number[]>;
  /** Seconds two vessels are assigned the same berth at once (should be 0). */
  sharedBerthS: number;
}

export function applyFerryBerths(plan: ServicePlan, infra: FerryInfra, cfg: FerryConfig): FerryBerthReport {
  const report: FerryBerthReport = { vessels: new Map(), sharedBerthS: 0 };
  const originals = plan.patterns.filter((p) => p.route === infra.route);
  if (!originals.length) return report;

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

  // Variant pattern per (original pattern, pair).
  const ends = new Map<number, { from: string; to: string }>();
  const variants = new Map<number, number[]>();
  const oldShapes = new Set(originals.map((p) => p.shape));
  for (const p of originals) {
    const from = terminalOf(p.stops[0]!);
    const to = terminalOf(p.stops[p.stops.length - 1]!);
    ends.set(p.id, { from, to });
    const ids: number[] = [];
    cfg.pairs.forEach((pair, k) => {
      const coords = berthPath(infra, from, pair[from]!, to, pair[to]!);
      const shape = `${infra.route}:${from}-${pair[from]}>${to}-${pair[to]}`;
      plan.shapes[shape] = coords;
      const cum = cumulativeLengths(coords);
      const dist = p.stops.map((_, i) => (i === 0 ? 0 : i === p.stops.length - 1 ? Math.round(cum[cum.length - 1]!) : NaN));
      if (dist.some(Number.isNaN)) throw new Error(`${infra.route}: pattern ${p.id} has intermediate stops`);
      if (k === 0) {
        p.shape = shape;
        p.dist = dist;
        ids.push(p.id);
      } else {
        const v: PlanPattern = { ...p, id: plan.patterns.length, shape, dist };
        plan.patterns.push(v);
        ids.push(v.id);
      }
    });
    variants.set(p.id, ids);
  }
  for (const id of oldShapes) if (!plan.patterns.some((p) => p.shape === id)) delete plan.shapes[id];

  // Group trips into vessels (blocks) per service.
  const vessels = new Map<string, PlanTrip[]>();
  for (const t of plan.trips) {
    if (!variants.has(t.pattern)) continue;
    const key = `${t.service}|${t.block ?? `trip:${t.id}`}`;
    let list = vessels.get(key);
    if (!list) vessels.set(key, (list = []));
    list.push(t);
  }
  const end = (t: PlanTrip) => t.start + t.arr[t.arr.length - 1]!;
  interface Vessel { service: string; trips: PlanTrip[]; span: [number, number]; docked: { terminal: string; t0: number; t1: number }[] }
  const list: Vessel[] = [];
  for (const [key, trips] of vessels) {
    trips.sort((a, b) => a.start - b.start);
    const docked: Vessel['docked'] = [];
    for (let i = 0; i + 1 < trips.length; i++) {
      const terminal = ends.get(trips[i]!.pattern)!.to;
      if (ends.get(trips[i + 1]!.pattern)!.from === terminal) docked.push({ terminal, t0: end(trips[i]!), t1: trips[i + 1]!.start });
    }
    list.push({ service: key.split('|')[0]!, trips, span: [trips[0]!.start, end(trips[trips.length - 1]!)], docked });
  }
  list.sort((a, b) => a.span[0] - b.span[0]);

  const assigned: { v: Vessel; pair: number }[] = [];
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (const v of list) {
    let best = 0;
    let bestCost: [number, number] = [Infinity, Infinity];
    for (let k = 0; k < cfg.pairs.length; k++) {
      let shared = 0;
      let concurrent = 0;
      for (const a of assigned) {
        if (a.pair !== k || a.v.service !== v.service) continue;
        if (overlap(...a.v.span, ...v.span) > 0) concurrent++;
        for (const d of v.docked) for (const e of a.v.docked) if (d.terminal === e.terminal) shared += overlap(d.t0, d.t1, e.t0, e.t1);
      }
      if (shared < bestCost[0] || (shared === bestCost[0] && concurrent < bestCost[1])) [best, bestCost] = [k, [shared, concurrent]];
    }
    assigned.push({ v, pair: best });
    report.sharedBerthS += bestCost[0];
    let counts = report.vessels.get(v.service);
    if (!counts) report.vessels.set(v.service, (counts = cfg.pairs.map(() => 0)));
    counts[best]!++;
    for (const t of v.trips) t.pattern = variants.get(t.pattern)![best]!;
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
