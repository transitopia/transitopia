// Observations → dispatcher inputs for SkyTrain (docs/skytrain-viz-PLAN.md §4.7, §4.11), and corrections for
// timetable vehicles (SeaBus, WCE, buses without real-time data).
//
// SkyTrain sightings become anchors: "the train running trip X was at stop i at time t". The
// dispatcher moves those stops and lets signalling carry the effect to the trains around it, so
// corrected trains stay consistent with each other. Pure: (movements, plan, observations, date).

import type { PreparedPlan } from "../schedule/engine.ts";
import type { MovementsFile } from "../movement/types.ts";
import { serviceDayStart } from "../time.ts";
import type { Consist, Observation } from "./types.ts";

/** A stop time the dispatcher must honour (service-day seconds). `at`: seen while stopped. */
export interface Anchor {
  run: string;
  trip: string;
  stop: number;
  t: number;
  event: "arrive" | "depart" | "at";
  source: string;
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

export interface RailInputs {
  anchors: Anchor[];
  /** Per run: cancelled trips, observed consist, observation instants and sources. */
  runs: Map<
    string,
    {
      cancelled: Set<string>;
      consist?: Consist;
      observed: { t: number; source: string }[];
      sources: Set<string>;
    }
  >;
  /** Out-of-service trains seen standing somewhere (parked observations). */
  parked: ParkedTrain[];
  /** Observations that couldn't be matched to a trip or run, with the reason. */
  unmatched: { obs: Observation; reason: string }[];
  /** SkyTrain observations applied. */
  used: number;
}

/** Positions within this of an observation count as observed (s). */
export const OBSERVED_WINDOW_S = 90;
/** A parked train seen once is shown this long either side of the sighting (s). */
const PARKED_DEFAULT_WINDOW_S = 15 * 60;
/** How far an at_platform observation may be from the scheduled time to match without a trip (s). */
const MATCH_WINDOW_S = 600;

/** SkyTrain observations for one service date as dispatcher inputs. */
export function railInputs(
  file: MovementsFile,
  pp: PreparedPlan,
  observations: Observation[],
  serviceDate: string,
): RailInputs {
  const dayStart = serviceDayStart(serviceDate);
  const toSec = (iso: string) => (Date.parse(iso) - dayStart) / 1000;
  const runOfTrip = new Map<string, string>();
  for (const r of file.runs)
    for (const e of r.events) if (e.k === "trip") runOfTrip.set(e.trip, r.id);
  const out: RailInputs = {
    anchors: [],
    runs: new Map(),
    parked: [],
    unmatched: [],
    used: 0,
  };
  const get = (runId: string) => {
    let c = out.runs.get(runId);
    if (!c)
      out.runs.set(
        runId,
        (c = { cancelled: new Set(), observed: [], sources: new Set() }),
      );
    return c;
  };
  const isoDate = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
  const railRoutes = new Set(
    [...pp.routes.values()]
      .filter((r) => r.kind === "skytrain")
      .map((r) => r.key),
  );
  for (const obs of observations) {
    if (obs.date !== isoDate) continue;
    // Other modes (SeaBus, WCE, buses) are reconciled by reconcileScheduled.
    if ("line" in obs && obs.line && !railRoutes.has(obs.line)) continue;
    if (
      "trip" in obs
      && obs.trip
      && !runOfTrip.has(obs.trip)
      && pp.tripIndex.has(obs.trip)
      && !railRoutes.has(pp.tripIndex.get(obs.trip)!.route.key)
    )
      continue;
    if (obs.kind === "parked") {
      const seen = toSec(obs.time);
      if (!Number.isFinite(seen)) {
        out.unmatched.push({ obs, reason: "unparseable time" });
        continue;
      }
      out.parked.push({
        at: obs.at,
        line: obs.line ?? "expo",
        seen,
        from: obs.from ? toSec(obs.from) : seen - PARKED_DEFAULT_WINDOW_S,
        until: obs.until ? toSec(obs.until) : seen + PARKED_DEFAULT_WINDOW_S,
        source: obs.source,
        ...(obs.consist ? { consist: obs.consist } : {}),
      });
      continue;
    }
    if (obs.kind === "at_platform") {
      const t = toSec(obs.time);
      if (!Number.isFinite(t)) {
        out.unmatched.push({ obs, reason: "unparseable time" });
        continue;
      }
      const match = matchAtPlatform(pp, runOfTrip, obs, t);
      if (!match) {
        out.unmatched.push({
          obs,
          reason: "no scheduled train at that stop near that time",
        });
        continue;
      }
      const c = get(match.run);
      c.observed.push({ t, source: obs.source });
      c.sources.add(obs.source);
      if (obs.consist) c.consist = obs.consist;
      out.anchors.push({
        run: match.run,
        trip: match.trip,
        stop: match.stop,
        t,
        event: obs.event ?? "at",
        source: obs.source,
      });
      continue;
    }
    const run = runOfTrip.get(obs.trip);
    if (!run) {
      out.unmatched.push({
        obs,
        reason: `trip ${obs.trip} isn't in a train run for this date`,
      });
      continue;
    }
    const c = get(run);
    c.sources.add(obs.source);
    if (obs.kind === "cancel") c.cancelled.add(obs.trip);
    else if (obs.kind === "consist") c.consist = obs.consist;
    else {
      // A delay: the trip leaves the first stop at or after `time` that many seconds late.
      const trip = pp.tripIndex.get(obs.trip)!;
      const from = obs.time ? toSec(obs.time) : trip.dep[0]!;
      let stop = trip.dep.findIndex(
        (d, i) => i < trip.dep.length - 1 && d >= from - 1,
      );
      if (stop < 0) stop = 0;
      out.anchors.push({
        run,
        trip: obs.trip,
        stop,
        t: trip.dep[stop]! + obs.seconds,
        event: "depart",
        source: obs.source,
      });
    }
  }
  out.anchors.sort((a, b) => a.t - b.t);
  out.used =
    out.anchors.length
    + out.parked.length
    + [...out.runs.values()].reduce((n, c) => n + c.cancelled.size, 0);
  return out;
}

function matchAtPlatform(
  pp: PreparedPlan,
  runOfTrip: Map<string, string>,
  obs: Extract<Observation, { kind: "at_platform" }>,
  t: number,
): { run: string; trip: string; stop: number; scheduled: number } | undefined {
  const stopMatches = (id: string) => {
    const s = pp.stopById.get(id);
    return (
      id === obs.stop
      || s?.name === obs.stop
      || s?.parent === obs.stop
      || (s
        && s.name.replace(/\s+(Station.*|(North|South|East|West)bound)$/, "")
          === obs.stop)
    );
  };
  let best:
    | {
        run: string;
        trip: string;
        stop: number;
        scheduled: number;
        err: number;
      }
    | undefined;
  const consider = (tripId: string) => {
    const pt = pp.tripIndex.get(tripId);
    const run = runOfTrip.get(tripId);
    if (!pt || !run) return;
    if (obs.line && pt.route.key !== obs.line) return;
    pt.pattern.stops.forEach((si, i) => {
      if (!stopMatches(pp.plan.stops[si]!.id)) return;
      const n = pt.arr.length;
      if (obs.event === "arrive" && i === 0) return;
      if (obs.event === "depart" && i === n - 1) return;
      const scheduled =
        obs.event === "arrive" ? pt.arr[i]!
        : obs.event === "depart" ? pt.dep[i]!
        : (pt.arr[i]! + pt.dep[i]!) / 2;
      const err = Math.abs(scheduled - t);
      if ((obs.trip || err <= MATCH_WINDOW_S) && (!best || err < best.err))
        best = { run, trip: tripId, stop: i, scheduled, err };
    });
  };
  if (obs.trip) consider(obs.trip);
  else for (const tripId of runOfTrip.keys()) consider(tripId);
  return (
    best && {
      run: best.run,
      trip: best.trip,
      stop: best.stop,
      scheduled: best.scheduled,
    }
  );
}

/** Corrections for timetable-based vehicles (SeaBus, WCE, buses without real-time data). */
export interface ScheduledCorrections {
  /** trip_id → time anchors (scheduled → shift, sorted) and observation instants (service-day seconds). */
  trips: Map<
    string,
    {
      anchors: { sched: number; shift: number }[];
      observed: { t: number; source: string }[];
    }
  >;
  cancelled: Set<string>;
  /** Vehicle chain (PreparedTrip.vehicleId) → consist / vessel name. */
  consists: Map<string, Consist>;
  unmatched: { obs: Observation; reason: string }[];
}

export function reconcileScheduled(
  pp: PreparedPlan,
  observations: Observation[],
  serviceDate: string,
): ScheduledCorrections {
  const dayStart = serviceDayStart(serviceDate);
  const toSec = (iso: string) => (Date.parse(iso) - dayStart) / 1000;
  const isoDate = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}`;
  const out: ScheduledCorrections = {
    trips: new Map(),
    cancelled: new Set(),
    consists: new Map(),
    unmatched: [],
  };
  const services = pp.servicesOn(serviceDate);
  const isScheduled = (routeKey: string) =>
    pp.routes.get(routeKey)?.kind !== "skytrain";
  const candidates = [...services]
    .flatMap((s) => pp.tripsByService.get(s) ?? [])
    .filter((t) => isScheduled(t.route.key));
  const note = (
    tripId: string,
    sched: number,
    shift: number,
    t: number | undefined,
    source: string,
  ) => {
    const c = out.trips.get(tripId) ?? { anchors: [], observed: [] };
    c.anchors = [
      ...c.anchors.filter((a) => a.sched !== sched),
      { sched, shift },
    ].sort((a, b) => a.sched - b.sched);
    if (t !== undefined) c.observed.push({ t, source });
    out.trips.set(tripId, c);
  };
  for (const obs of observations) {
    if (obs.date !== isoDate || obs.kind === "parked") continue;
    if (obs.kind === "at_platform") {
      if (obs.line && !isScheduled(obs.line)) continue;
      if (!obs.line && !obs.trip) continue; // ambiguous across modes: SkyTrain reconciler handles it
      const t = toSec(obs.time);
      let best:
        | { trip: string; vehicle: string; scheduled: number; err: number }
        | undefined;
      for (const pt of obs.trip ?
        candidates.filter((c) => c.trip.id === obs.trip)
      : candidates) {
        if (obs.line && pt.route.key !== obs.line) continue;
        const n = pt.arr.length;
        pt.pattern.stops.forEach((si, i) => {
          const s = pp.plan.stops[si]!;
          const matches =
            s.id === obs.stop
            || s.name === obs.stop
            || s.parent === obs.stop
            || s.name.replace(
              /\s+(Station.*|(North|South|East|West)bound)$/,
              "",
            ) === obs.stop;
          if (
            !matches
            || (obs.event === "arrive" && i === 0)
            || (obs.event === "depart" && i === n - 1)
          )
            return;
          const scheduled =
            obs.event === "arrive" ? pt.arr[i]!
            : obs.event === "depart" ? pt.dep[i]!
            : (pt.arr[i]! + pt.dep[i]!) / 2;
          const err = Math.abs(scheduled - t);
          if ((obs.trip || err <= MATCH_WINDOW_S) && (!best || err < best.err))
            best = { trip: pt.trip.id, vehicle: pt.vehicleId, scheduled, err };
        });
      }
      if (!best) {
        out.unmatched.push({
          obs,
          reason: "no scheduled vehicle at that stop near that time",
        });
        continue;
      }
      note(best.trip, best.scheduled, t - best.scheduled, t, obs.source);
      if (obs.consist) out.consists.set(best.vehicle, obs.consist);
      continue;
    }
    const trip = pp.tripIndex.get(obs.trip);
    if (!trip || !isScheduled(trip.route.key)) continue;
    if (obs.kind === "cancel") out.cancelled.add(obs.trip);
    else if (obs.kind === "delay")
      note(
        obs.trip,
        obs.time ? toSec(obs.time) : trip.trip.start,
        obs.seconds,
        undefined,
        obs.source,
      );
    else out.consists.set(trip.vehicleId, obs.consist);
  }
  return out;
}
