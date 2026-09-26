// Reconcile observations with inferred runs (PLAN.md §4.7). Produces, per run, a time warp (the
// run's schedule shifted by observed delays that decay at terminus layovers), cancelled trips, an
// observed consist, and windows where the position counts as observed.
//
// Pure: (movements, plan, observations, service date) → RunCorrections.

import type { PreparedPlan } from '../schedule/engine.ts';
import type { MovementsFile } from '../movement/types.ts';
import { serviceDayStart } from '../time.ts';
import type { Consist, Observation } from './types.ts';

/** Real time t within [t0, t1) shows the schedule as of t − shift. Service-day seconds. */
export interface Shift {
  t0: number;
  t1: number;
  shift: number;
}

export interface RunCorrection {
  shifts: Shift[];
  cancelled: Set<string>;
  consist?: Consist;
  /** Observation instants (service-day seconds) and their sources. */
  observed: { t: number; source: string }[];
  sources: Set<string>;
}

export interface ParkedTrain {
  at: [number, number];
  line: string;
  /** Service-day seconds. */
  seen: number;
  from: number;
  until: number;
  source: string;
  consist?: Consist;
}

export interface ReconcileResult {
  runs: Map<string, RunCorrection>;
  /** Out-of-service trains seen standing somewhere (parked observations). */
  parked: ParkedTrain[];
  /** Observations that couldn't be matched to a trip or run, with the reason. */
  unmatched: { obs: Observation; reason: string }[];
}

/** Positions within this of an observation count as observed (s). */
export const OBSERVED_WINDOW_S = 90;
/** A parked train seen once is shown this long either side of the sighting (s). */
const PARKED_DEFAULT_WINDOW_S = 15 * 60;
/** Minimum turnaround when absorbing delay at a terminus (s). */
const MIN_TURN_S = 60;
/** How far an at_platform observation may be from the scheduled time to match without a trip (s). */
const MATCH_WINDOW_S = 600;

export function reconcile(file: MovementsFile, pp: PreparedPlan, observations: Observation[], serviceDate: string): ReconcileResult {
  const dayStart = serviceDayStart(serviceDate);
  const toSec = (iso: string) => (Date.parse(iso) - dayStart) / 1000;
  const runOfTrip = new Map<string, string>();
  for (const r of file.runs) for (const e of r.events) if (e.k === 'trip') runOfTrip.set(e.trip, r.id);
  const runs = new Map<string, RunCorrection>();
  const unmatched: ReconcileResult['unmatched'] = [];
  const parked: ParkedTrain[] = [];
  const get = (runId: string) => {
    let c = runs.get(runId);
    if (!c) runs.set(runId, (c = { shifts: [], cancelled: new Set(), observed: [], sources: new Set() }));
    return c;
  };
  const isoDate = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
  const delays = new Map<string, { trip: string; fromT: number; seconds: number }[]>();

  const railRoutes = new Set([...pp.routes.values()].filter((r) => r.kind === 'skytrain').map((r) => r.key));
  for (const obs of observations) {
    if (obs.date !== isoDate) continue;
    // Other modes (SeaBus, WCE, buses) are reconciled by reconcileScheduled.
    if ('line' in obs && obs.line && !railRoutes.has(obs.line)) continue;
    if ('trip' in obs && obs.trip && !runOfTrip.has(obs.trip) && pp.tripIndex.has(obs.trip) && !railRoutes.has(pp.tripIndex.get(obs.trip)!.route.key)) continue;
    if (obs.kind === 'parked') {
      const seen = toSec(obs.time);
      if (!Number.isFinite(seen)) {
        unmatched.push({ obs, reason: 'unparseable time' });
        continue;
      }
      parked.push({
        at: obs.at,
        line: obs.line ?? 'expo',
        seen,
        from: obs.from ? toSec(obs.from) : seen - PARKED_DEFAULT_WINDOW_S,
        until: obs.until ? toSec(obs.until) : seen + PARKED_DEFAULT_WINDOW_S,
        source: obs.source,
        ...(obs.consist ? { consist: obs.consist } : {}),
      });
      continue;
    }
    if (obs.kind === 'at_platform') {
      const t = toSec(obs.time);
      if (!Number.isFinite(t)) {
        unmatched.push({ obs, reason: 'unparseable time' });
        continue;
      }
      const match = matchAtPlatform(pp, runOfTrip, obs, t);
      if (!match) {
        unmatched.push({ obs, reason: 'no scheduled train at that stop near that time' });
        continue;
      }
      const c = get(match.run);
      c.observed.push({ t, source: obs.source });
      c.sources.add(obs.source);
      if (obs.consist) c.consist = obs.consist;
      const d = t - match.scheduled;
      if (Math.abs(d) >= 1) (delays.get(match.run) ?? delays.set(match.run, []).get(match.run)!).push({ trip: match.trip, fromT: match.scheduled - 1, seconds: d });
    } else {
      const run = runOfTrip.get(obs.trip);
      if (!run) {
        unmatched.push({ obs, reason: `trip ${obs.trip} isn't in a train run for this date` });
        continue;
      }
      const c = get(run);
      c.sources.add(obs.source);
      if (obs.kind === 'cancel') c.cancelled.add(obs.trip);
      else if (obs.kind === 'consist') c.consist = obs.consist;
      else {
        const trip = pp.tripIndex.get(obs.trip)!;
        const fromT = obs.time ? toSec(obs.time) : trip.dep[0]!;
        (delays.get(run) ?? delays.set(run, []).get(run)!).push({ trip: obs.trip, fromT, seconds: obs.seconds });
      }
    }
  }

  // Delays → shifts, absorbed by later layovers. The latest observation wins from its time on.
  for (const [runId, ds] of delays) {
    const run = file.runs.find((r) => r.id === runId)!;
    const trips = run.events.flatMap((e) => (e.k === 'trip' ? [pp.tripIndex.get(e.trip)!] : []));
    ds.sort((a, b) => a.fromT - b.fromT);
    const shifts: Shift[] = [];
    ds.forEach((dly, idx) => {
      const until = ds[idx + 1]?.fromT ?? Infinity;
      let k = trips.findIndex((t) => t.trip.id === dly.trip);
      let d = dly.seconds;
      let start = dly.fromT;
      while (k >= 0 && k < trips.length && d !== 0 && start < until) {
        const t = trips[k]!;
        const end = t.arr[t.arr.length - 1]! + d;
        shifts.push({ t0: start, t1: Math.min(end, until), shift: d });
        const next = trips[k + 1];
        if (!next) break;
        // Layover absorbs lateness (keeping a minimum turnaround); an early train simply waits for
        // its scheduled departure, so earliness never carries into the next trip.
        const slack = next.dep[0]! - t.arr[t.arr.length - 1]! - MIN_TURN_S;
        const nd = d > 0 ? Math.max(0, d - Math.max(0, slack)) : 0;
        // During the layover the train waits at the terminus: show the schedule's layover position.
        if (end < next.dep[0]! + nd) shifts.push({ t0: end, t1: Math.min(next.dep[0]! + nd, until), shift: Math.max(0, Math.min(d, nd)) });
        d = nd;
        start = next.dep[0]! + nd;
        k++;
      }
    });
    get(runId).shifts = shifts.filter((s) => s.t1 > s.t0).sort((a, b) => a.t0 - b.t0);
  }
  return { runs, parked, unmatched };
}

function matchAtPlatform(
  pp: PreparedPlan,
  runOfTrip: Map<string, string>,
  obs: Extract<Observation, { kind: 'at_platform' }>,
  t: number,
): { run: string; trip: string; scheduled: number } | undefined {
  const stopMatches = (id: string) => {
    const s = pp.stopById.get(id);
    return id === obs.stop || s?.name === obs.stop || s?.parent === obs.stop || (s && s.name.replace(/\s+Station.*$/, '') === obs.stop);
  };
  let best: { run: string; trip: string; scheduled: number; err: number } | undefined;
  const consider = (tripId: string) => {
    const pt = pp.tripIndex.get(tripId);
    const run = runOfTrip.get(tripId);
    if (!pt || !run) return;
    if (obs.line && pt.route.key !== obs.line) return;
    pt.pattern.stops.forEach((si, i) => {
      if (!stopMatches(pp.plan.stops[si]!.id)) return;
      const n = pt.arr.length;
      if (obs.event === 'arrive' && i === 0) return;
      if (obs.event === 'depart' && i === n - 1) return;
      const scheduled = obs.event === 'arrive' ? pt.arr[i]! : obs.event === 'depart' ? pt.dep[i]! : (pt.arr[i]! + pt.dep[i]!) / 2;
      const err = Math.abs(scheduled - t);
      if ((obs.trip || err <= MATCH_WINDOW_S) && (!best || err < best.err)) best = { run, trip: tripId, scheduled, err };
    });
  };
  if (obs.trip) consider(obs.trip);
  else for (const tripId of runOfTrip.keys()) consider(tripId);
  return best && { run: best.run, trip: best.trip, scheduled: best.scheduled };
}

/** Schedule time to evaluate for real time t on a run (identity when no shift applies). */
export function warp(c: RunCorrection | undefined, t: number): number {
  if (!c) return t;
  for (const s of c.shifts) if (t >= s.t0 && t < s.t1) return t - s.shift;
  return t;
}

/** Corrections for timetable-based vehicles (SeaBus, WCE, buses without real-time data). */
export interface ScheduledCorrections {
  /** trip_id → time shift and observation instants (service-day seconds). */
  trips: Map<string, { shift: number; observed: { t: number; source: string }[] }>;
  cancelled: Set<string>;
  /** Vehicle chain (PreparedTrip.vehicleId) → consist / vessel name. */
  consists: Map<string, Consist>;
  unmatched: { obs: Observation; reason: string }[];
}

export function reconcileScheduled(pp: PreparedPlan, observations: Observation[], serviceDate: string): ScheduledCorrections {
  const dayStart = serviceDayStart(serviceDate);
  const toSec = (iso: string) => (Date.parse(iso) - dayStart) / 1000;
  const isoDate = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
  const out: ScheduledCorrections = { trips: new Map(), cancelled: new Set(), consists: new Map(), unmatched: [] };
  const services = pp.servicesOn(serviceDate);
  const isScheduled = (routeKey: string) => pp.routes.get(routeKey)?.kind !== 'skytrain';
  const candidates = [...services].flatMap((s) => pp.tripsByService.get(s) ?? []).filter((t) => isScheduled(t.route.key));
  const note = (tripId: string, shift: number, t: number | undefined, source: string) => {
    const c = out.trips.get(tripId) ?? { shift: 0, observed: [] };
    c.shift = shift;
    if (t !== undefined) c.observed.push({ t, source });
    out.trips.set(tripId, c);
  };
  for (const obs of observations) {
    if (obs.date !== isoDate || obs.kind === 'parked') continue;
    if (obs.kind === 'at_platform') {
      if (obs.line && !isScheduled(obs.line)) continue;
      if (!obs.line && !obs.trip) continue; // ambiguous across modes: SkyTrain reconciler handles it
      const t = toSec(obs.time);
      let best: { trip: string; vehicle: string; scheduled: number; err: number } | undefined;
      for (const pt of obs.trip ? candidates.filter((c) => c.trip.id === obs.trip) : candidates) {
        if (obs.line && pt.route.key !== obs.line) continue;
        const n = pt.arr.length;
        pt.pattern.stops.forEach((si, i) => {
          const s = pp.plan.stops[si]!;
          const matches = s.id === obs.stop || s.name === obs.stop || s.parent === obs.stop || s.name.replace(/\s+Station.*$/, '') === obs.stop;
          if (!matches || (obs.event === 'arrive' && i === 0) || (obs.event === 'depart' && i === n - 1)) return;
          const scheduled = obs.event === 'arrive' ? pt.arr[i]! : obs.event === 'depart' ? pt.dep[i]! : (pt.arr[i]! + pt.dep[i]!) / 2;
          const err = Math.abs(scheduled - t);
          if ((obs.trip || err <= MATCH_WINDOW_S) && (!best || err < best.err)) best = { trip: pt.trip.id, vehicle: pt.vehicleId, scheduled, err };
        });
      }
      if (!best) {
        out.unmatched.push({ obs, reason: 'no scheduled vehicle at that stop near that time' });
        continue;
      }
      note(best.trip, t - best.scheduled, t, obs.source);
      if (obs.consist) out.consists.set(best.vehicle, obs.consist);
      continue;
    }
    const trip = pp.tripIndex.get(obs.trip);
    if (!trip || !isScheduled(trip.route.key)) continue;
    if (obs.kind === 'cancel') out.cancelled.add(obs.trip);
    else if (obs.kind === 'delay') note(obs.trip, obs.seconds, undefined, obs.source);
    else out.consists.set(trip.vehicleId, obs.consist);
  }
  return out;
}
