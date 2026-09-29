// Scenario service operations (PLAN.md §4.8): produce a modified service plan. Run times for new
// hops come from the physical minimum over the approximate distance (straight line × curvature
// allowance) times a padding factor, plus dwell. Movement building later fits real track paths.

import { cumulativeLengths, distM, pointAlong, type LonLat } from '../geo.ts';
import { kinematicsFor, minLegTime, type KinematicsConfig } from '../movement/kinematics.ts';
import type { PlanPattern, PlanStop, PlanTrip, ServicePlan } from '../plan/types.ts';
import type { NewStation, ServiceOperation } from './types.ts';

/** Straight-line distance × this ≈ track distance for run-time estimates. */
const CURVATURE = 1.12;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function applyService(base: ServicePlan, ops: ServiceOperation[], kin: KinematicsConfig, suffix: string): ServicePlan {
  const plan: ServicePlan = structuredClone(base);
  plan.feedVersion = `${base.feedVersion}~${suffix}`;
  for (const op of ops) {
    if (op.op === 'extend') extend(plan, op, kin);
    else if (op.op === 'truncate') truncate(plan, op);
  }
  return plan;
}

function truncate(plan: ServicePlan, op: Extract<ServiceOperation, { op: 'truncate' }>): void {
  if (!plan.routes.some((r) => r.key === op.route)) throw new Error(`truncate: unknown route ${op.route}`);
  const radius = op.radiusM ?? 300;
  const coords = (si: number): LonLat => [plan.stops[si]!.lon, plan.stops[si]!.lat];
  const nearestIndex = (p: PlanPattern, at: LonLat) => {
    let best = -1;
    let bd = Infinity;
    p.stops.forEach((si, i) => {
      const d = distM(coords(si), at);
      if (d < bd) [bd, best] = [d, i];
    });
    return { i: best, d: bd };
  };
  // New pattern (or null = drop) per affected pattern; `from`/`to` are the kept stop index range.
  const cut = new Map<number, { pattern: PlanPattern; from: number; to: number } | null>();
  for (const p of plan.patterns.filter((x) => x.route === op.route)) {
    const c = nearestIndex(p, op.at);
    const keepSideNearFirst = distM(coords(p.stops[0]!), op.keep) < distM(coords(p.stops[p.stops.length - 1]!), op.keep);
    if (c.d > radius) {
      // Doesn't reach the cut point: keep only if it lies on the kept side.
      const k = nearestIndex(p, op.keep);
      if (distM(coords(p.stops[k.i]!), op.keep) > distM(coords(p.stops[k.i]!), op.at)) cut.set(p.id, null);
      continue;
    }
    const [from, to] = keepSideNearFirst ? [0, c.i] : [c.i, p.stops.length - 1];
    if (to - from < 1) {
      cut.set(p.id, null);
      continue;
    }
    if (from === 0 && to === p.stops.length - 1) continue;
    const shape = plan.shapes[p.shape] ?? [];
    const newShape = `${p.shape}~cut`;
    plan.shapes[newShape] = sliceShape(shape, p.dist[from]!, p.dist[to]!);
    const np: PlanPattern = {
      id: plan.patterns.length,
      route: p.route,
      direction: p.direction,
      shape: newShape,
      stops: p.stops.slice(from, to + 1),
      dist: p.dist.slice(from, to + 1).map((d) => d - p.dist[from]!),
    };
    plan.patterns.push(np);
    cut.set(p.id, { pattern: np, from, to });
  }
  const kept: PlanTrip[] = [];
  for (const t of plan.trips) {
    if (!cut.has(t.pattern)) {
      kept.push(t);
      continue;
    }
    const c = cut.get(t.pattern);
    if (!c) continue;
    const dep = t.dep ?? t.arr;
    const t0 = dep[c.from]!;
    const lastName = op.terminusName ?? plan.stops[c.pattern.stops[c.pattern.stops.length - 1]!]!.name.replace(/^\w+bound\s+/, '');
    kept.push({
      ...t,
      pattern: c.pattern.id,
      start: t.start + t0,
      arr: t.arr.slice(c.from, c.to + 1).map((x) => x - t0),
      ...(t.dep ? { dep: t.dep.slice(c.from, c.to + 1).map((x) => x - t0) } : {}),
      headsign: c.to < plan.patterns[t.pattern]!.stops.length - 1 ? t.headsign.replace(/To .*$/, `To ${lastName}`) : t.headsign,
    });
  }
  plan.trips = kept.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** The part of a polyline between two distances along it (m). */
function sliceShape(coords: LonLat[], from: number, to: number): LonLat[] {
  if (coords.length < 2) return coords;
  const cum = cumulativeLengths(coords);
  const out: LonLat[] = [];
  const at = (d: number): LonLat => {
    const p = pointAlong(coords, cum, d);
    return [p.lon, p.lat];
  };
  out.push(at(from));
  for (let i = 0; i < coords.length; i++) if (cum[i]! > from && cum[i]! < to) out.push(coords[i]!);
  out.push(at(to));
  return out;
}

function extend(plan: ServicePlan, op: Extract<ServiceOperation, { op: 'extend' }>, kinCfg: KinematicsConfig): void {
  const route = plan.routes.find((r) => r.key === op.route);
  if (!route) throw new Error(`extend: unknown route ${op.route}`);
  const station = plan.stations.find((s) => s.name === op.at);
  if (!station) throw new Error(`extend: no station named "${op.at}"`);
  const kin = kinematicsFor(kinCfg, route.mode, route.key);
  const padding = op.padding ?? 1.15;
  const dwell = op.dwell ?? kin.dwell;
  const stationOf = (si: number) => plan.stops[si]!.parent ?? plan.stops[si]!.id;

  // New stations: two platforms each (outbound = P1, inbound = P2).
  const outbound: number[] = [];
  const inbound: number[] = [];
  const addStop = (st: NewStation, n: 1 | 2): number => {
    const parent = `scn-${slug(st.name)}`;
    const s: PlanStop = { id: `${parent}-p${n}`, name: `${st.name} Station @ Platform ${n}`, lon: st.at[0], lat: st.at[1], parent, platform: String(n) };
    plan.stops.push(s);
    return plan.stops.length - 1;
  };
  for (const st of op.stations) {
    outbound.push(addStop(st, 1));
    inbound.push(addStop(st, 2));
    plan.stations.push({ id: `scn-${slug(st.name)}`, name: st.name, lon: st.at[0], lat: st.at[1], routes: [route.key] });
  }
  const coords = (si: number): LonLat => [plan.stops[si]!.lon, plan.stops[si]!.lat];
  /** Run time (s) for a hop of straight-line distance d, and the estimated track distance. */
  const hop = (a: LonLat, b: LonLat) => {
    const d = distM(a, b) * CURVATURE;
    return { d, t: Math.round(minLegTime(d, kin) * padding) };
  };

  // Patterns ending / starting at the terminus get extended versions.
  const extended = new Map<number, { pattern: PlanPattern; addBefore: number[]; addAfter: number[] }>();
  for (const p of plan.patterns.filter((x) => x.route === route.key)) {
    const endsHere = stationOf(p.stops[p.stops.length - 1]!) === station.id;
    const startsHere = stationOf(p.stops[0]!) === station.id;
    if (!endsHere && !startsHere) continue;
    const addAfter = endsHere ? outbound : [];
    const addBefore = startsHere ? [...inbound].reverse() : [];
    const shape = plan.shapes[p.shape] ?? [];
    const newShapeId = `${p.shape}~${slug(op.at)}`;
    plan.shapes[newShapeId] = [...addBefore.map(coords), ...shape, ...addAfter.map(coords)];
    // Distances: prefix hops, original (shifted), suffix hops.
    const pre: number[] = [];
    let acc = 0;
    for (let i = 0; i < addBefore.length; i++) {
      pre.push(acc);
      const next = i + 1 < addBefore.length ? coords(addBefore[i + 1]!) : coords(p.stops[0]!);
      acc += hop(coords(addBefore[i]!), next).d;
    }
    const shifted = p.dist.map((d) => Math.round(d + acc));
    const post: number[] = [];
    let last = shifted[shifted.length - 1]!;
    let prev = coords(p.stops[p.stops.length - 1]!);
    for (const si of addAfter) {
      last += hop(prev, coords(si)).d;
      post.push(Math.round(last));
      prev = coords(si);
    }
    const np: PlanPattern = {
      id: plan.patterns.length,
      route: p.route,
      direction: p.direction,
      shape: newShapeId,
      stops: [...addBefore, ...p.stops, ...addAfter],
      dist: [...pre.map(Math.round), ...shifted, ...post],
    };
    plan.patterns.push(np);
    extended.set(p.id, { pattern: np, addBefore, addAfter });
  }

  // Retime affected trips.
  for (const t of plan.trips) {
    const ext = extended.get(t.pattern);
    if (!ext) continue;
    const old = plan.patterns[t.pattern]!;
    const dep = t.dep ?? t.arr;
    // Prefix: new stops before the original first stop.
    const preTimes: number[] = [];
    let acc = 0;
    for (let i = ext.addBefore.length - 1; i >= 0; i--) {
      const next = i + 1 < ext.addBefore.length ? coords(ext.addBefore[i + 1]!) : coords(old.stops[0]!);
      acc += hop(coords(ext.addBefore[i]!), next).t + dwell;
      preTimes.unshift(-acc);
    }
    const arr = [...preTimes, ...t.arr];
    const deps = [...preTimes, ...dep];
    // Suffix: continue after the original last stop.
    let tt = t.arr[t.arr.length - 1]! + (ext.addAfter.length ? dwell : 0);
    let prev = coords(old.stops[old.stops.length - 1]!);
    if (ext.addAfter.length) deps[deps.length - 1] = tt;
    for (const si of ext.addAfter) {
      tt += hop(prev, coords(si)).t;
      arr.push(tt);
      deps.push(tt);
      tt += dwell;
      prev = coords(si);
    }
    const start = t.start + (preTimes[0] ?? 0);
    const shift = -(preTimes[0] ?? 0);
    const trip: PlanTrip = t;
    trip.pattern = ext.pattern.id;
    trip.start = start;
    trip.arr = arr.map((x) => x + shift);
    const depAdj = deps.map((x) => x + shift);
    if (depAdj.some((d, i) => d !== trip.arr[i])) trip.dep = depAdj;
    else delete trip.dep;
    const lastName = plan.stops[ext.pattern.stops[ext.pattern.stops.length - 1]!]!.name.replace(/\s+Station.*$/, '');
    if (ext.addAfter.length) trip.headsign = trip.headsign.replace(/To .*$/, `To ${lastName}`);
  }
  plan.trips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
