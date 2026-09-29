// Dispatcher entry point (PLAN.md §4.11): inferred runs in, a signalling-feasible movement file out.
//
//   dispatch(movements, plan, graph, config) → movements (schema 2) + summary
//
// Trips that run on their plan times stay stored by reference; trips the simulation moved get
// explicit stop times, signal waits and (where they left their planned profile) the simulated
// trajectory, which playback follows.

import { distM } from "../geo.ts";
import type { TrackGraph } from "../infra/graph.ts";
import type { KinematicsConfig } from "../movement/kinematics.ts";
import type {
  DispatchSummary,
  HopVia,
  HopWait,
  MovementsFile,
  Run,
  RunEvent,
} from "../movement/types.ts";
import type { PreparedPlan } from "../schedule/engine.ts";
import {
  applyAnchors,
  buildModels,
  type AnchorInput,
  type MoveItem,
  type RoutePiece,
  type TrainModel,
} from "./model.ts";
import type { RailInputs } from "../corrections/reconcile.ts";
import {
  simulate,
  simulateAsync,
  type DispatchConfig,
  type MoveRecord,
  type SignalWait,
  type SimResult,
  type WaitRecord,
} from "./sim.ts";

export type { DispatchConfig } from "./sim.ts";

export interface DispatchOptions {
  config: DispatchConfig;
  kin: KinematicsConfig;
  deadheadSpeedFactor: number;
  turnbackSpeedFactor: number;
  /** Labels for the inputs used (shown with the result). */
  inputs?: string[];
  date?: string;
  /** Observations for this date (anchors, cancellations, consists, parked trains). */
  rail?: RailInputs;
  /** The date's base plan (already dispatched): runs whose times differ from it are marked adjusted. */
  base?: MovementsFile;
}

/** Stops that moved at least this far from the base plan count as adjusted (s). */
const ADJUSTED_S = 5;

/** Times within this of the plan are kept exactly, so on-time trips stay stored by reference (s). */
const SAME_S = 0.5;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function dispatch(
  file: MovementsFile,
  pp: PreparedPlan,
  g: TrackGraph,
  opts: DispatchOptions,
): MovementsFile {
  const started = performance.now();
  const models = modelsFor(file, pp, opts);
  return finish(
    file,
    pp,
    g,
    opts,
    models,
    simulate(models, g, opts.config, speedsOf(opts)),
    started,
  );
}

/** The same as dispatch(), yielding to the event loop while it simulates (for servers). */
export async function dispatchAsync(
  file: MovementsFile,
  pp: PreparedPlan,
  g: TrackGraph,
  opts: DispatchOptions,
): Promise<MovementsFile> {
  const started = performance.now();
  const models = modelsFor(file, pp, opts);
  return finish(
    file,
    pp,
    g,
    opts,
    models,
    await simulateAsync(models, g, opts.config, speedsOf(opts)),
    started,
  );
}

const speedsOf = (opts: DispatchOptions) => ({
  deadhead: opts.deadheadSpeedFactor,
  turnback: opts.turnbackSpeedFactor,
});

function modelsFor(
  file: MovementsFile,
  pp: PreparedPlan,
  opts: DispatchOptions,
): TrainModel[] {
  const models = buildModels(file, pp, opts.kin, {
    minHoldS: opts.config.minHoldS,
  });
  if (opts.rail?.anchors.length)
    applyAnchors(models, opts.rail.anchors as AnchorInput[], pp);
  return models;
}

function finish(
  file: MovementsFile,
  pp: PreparedPlan,
  g: TrackGraph,
  opts: DispatchOptions,
  models: TrainModel[],
  sim: SimResult,
  started: number,
): MovementsFile {
  const stations = pp.plan.stations;
  const placeOf = (seg: string, offset: number) => {
    const p = g.pointAt({ seg, offset });
    let best = "";
    let bd = Infinity;
    for (const st of stations) {
      const d = distM([st.lon, st.lat], [p.lon, p.lat]);
      if (d < bd) {
        bd = d;
        best = st.name;
      }
    }
    return bd < 400 ? best : `near ${best}`;
  };

  const delays = new Map<string, number[]>();
  const holds: Record<string, number> = {};
  const baseRuns = new Map(opts.base?.runs.map((r) => [r.id, r]));
  const runs: Run[] = models.map((m, ti) => {
    const recs = sim.records[ti]!;
    if (recs.length !== m.items.length) return m.run; // unfinished (shouldn't happen): keep the plan
    const run = emitRun(
      m,
      recs,
      pp,
      (seg, offset, why) => {
        const k = `${placeOf(seg, offset)} (${why})`;
        holds[k] = (holds[k] ?? 0) + 1;
      },
      (line, d) =>
        (delays.get(line) ?? delays.set(line, []).get(line)!).push(d),
    );
    const info = opts.rail?.runs.get(run.id);
    if (info) {
      if (info.observed.length)
        run.observed = [...info.observed].sort((a, b) => a.t - b.t);
      if (info.sources.size) run.sources = [...info.sources].sort();
      if (info.cancelled.size) run.cancelled = [...info.cancelled].sort();
      if (info.consist) run.consist = info.consist;
    }
    const base = baseRuns.get(run.id);
    if (base) {
      const spans = adjustedSpans(base, run, pp);
      if (spans.length) run.adjusted = spans;
    }
    return run;
  });

  const delay: DispatchSummary["delay"] = {};
  for (const [line, ds] of [...delays].sort()) {
    const sorted = [...ds].sort((a, b) => a - b);
    const q = (f: number) =>
      Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0,
      );
    delay[line] = {
      trips: sorted.length,
      late: sorted.filter((d) => d >= 30).length,
      median: q(0.5),
      p95: q(0.95),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
    };
  }
  const summary: DispatchSummary = {
    ...(opts.date ? { date: opts.date } : {}),
    inputs: opts.inputs ?? [],
    delay,
    holds: Object.fromEntries(
      Object.entries(holds).sort((a, b) => b[1] - a[1]),
    ),
    forced: sim.forced.map((f) => ({
      run: f.run,
      t: f.t,
      where: placeOf(f.seg, f.offset),
      why: f.why,
    })),
    ms: Math.round(performance.now() - started),
  };
  return {
    ...file,
    schema: 2,
    runs,
    dispatch: summary,
    ...(opts.rail?.parked.length ? { parked: opts.rail.parked } : {}),
  };
}

function emitRun(
  m: TrainModel,
  recs: (MoveRecord | WaitRecord)[],
  pp: PreparedPlan,
  noteHold: (seg: string, offset: number, why: string) => void,
  noteDelay: (line: string, seconds: number) => void,
): Run {
  const n = m.items.length;
  const startOf = (j: number) => {
    const r = recs[j]!;
    return r.k === "wait" ? r.t0 : r.dep;
  };
  // A wait lasts until the next item starts (a blocked departure extends it).
  const endOf = (j: number) => {
    const r = recs[j]!;
    if (r.k === "move") return r.arr;
    return j + 1 < n ? startOf(j + 1) : r.t1;
  };
  const keep = (x: number, planned: number) =>
    Math.abs(x - planned) < SAME_S ? planned : r1(x);
  const posAt = (G: number) => {
    const p = pieceFor(m.route, G);
    return { seg: p.seg, offset: p.from + (G - p.g0) * p.dir, dir: p.dir };
  };

  const byEvent = new Map<number, number[]>();
  m.items.forEach((it, j) =>
    (byEvent.get(it.ev) ?? byEvent.set(it.ev, []).get(it.ev)!).push(j),
  );
  const events: RunEvent[] = [];
  m.run.events.forEach((e, ev) => {
    const js = byEvent.get(ev) ?? [];
    if (e.k === "hold") {
      const j = js[0]!;
      events.push({
        ...e,
        t0: keep(startOf(j), e.t0),
        t1: keep(endOf(j), e.t1),
      });
      return;
    }
    if (e.k === "move") {
      const j = js[0]!;
      const it = m.items[j] as MoveItem;
      const r = recs[j] as MoveRecord;
      const { via: _v, waits: _w, ...rest } = e;
      const out: RunEvent = {
        ...rest,
        t0: keep(r.dep, e.t0),
        t1: keep(r.arr, e.t1),
      };
      if (r.via) out.via = packVia(r.via);
      if (r.waits.length) out.waits = r.waits.map((w) => hopWait(it, w, 0));
      for (const w of r.waits) {
        const at = posAt(w.g);
        noteHold(at.seg, at.offset, w.why);
      }
      events.push(out);
      return;
    }
    // Revenue trip: stop times from the records.
    const t = pp.tripIndex.get(e.trip)!;
    const stops = t.arr.length;
    const times: number[] = [];
    const waits: HopWait[] = [];
    const via: HopVia[] = [];
    let changed = false;
    for (let s = 0; s < stops; s++) {
      let arr = t.arr[s]!;
      let dep = t.dep[s]!;
      for (const j of js) {
        const it = m.items[j]!;
        const r = recs[j]!;
        if (it.k === "move" && it.hop === s && r.k === "move") dep = r.dep;
        if (it.k === "move" && it.hop === s - 1 && r.k === "move") {
          arr = r.arr;
          if (s === stops - 1) dep = arr + (t.dep[s]! - t.arr[s]!);
          for (const w of r.waits) waits.push(hopWait(it, w, it.hop!));
          if (r.via) via.push({ hop: it.hop!, pts: packVia(r.via) });
        }
      }
      const a = keep(arr, t.arr[s]!);
      const d = keep(dep, t.dep[s]!);
      if (a !== t.arr[s] || d !== t.dep[s]) changed = true;
      times.push(a, d);
    }
    for (const w of waits) {
      const it = js
        .map((j) => m.items[j]!)
        .find((x): x is MoveItem => x.k === "move" && x.hop === w.hop)!;
      const at = posAt(it.g0 + w.d);
      noteHold(at.seg, at.offset, w.why);
    }
    noteDelay(m.line, times[times.length - 2]! - t.arr[stops - 1]!);
    const { times: _t, waits: _w, via: _v, ...rest } = e;
    events.push(
      changed || waits.length || via.length ?
        {
          ...rest,
          times,
          ...(waits.length ? { waits } : {}),
          ...(via.length ? { via } : {}),
        }
      : rest,
    );
  });
  return { ...m.run, events };
}

/** When each event of a run starts and ends (trip times from the event or the plan). */
function eventTimes(e: RunEvent, pp: PreparedPlan): number[] {
  if (e.k !== "trip") return [e.t0, e.t1];
  if (e.times) return e.times;
  const t = pp.tripIndex.get(e.trip)!;
  return Array.from(t.arr, (a, i) => [a, t.dep[i]!]).flat();
}

/** Service-day spans where a run's times differ from its base plan by ≥ ADJUSTED_S. */
function adjustedSpans(
  base: Run,
  run: Run,
  pp: PreparedPlan,
): [number, number][] {
  const spans: [number, number][] = [];
  const n = Math.min(base.events.length, run.events.length);
  for (let i = 0; i < n; i++) {
    const a = eventTimes(base.events[i]!, pp);
    const b = eventTimes(run.events[i]!, pp);
    if (
      a.length !== b.length
      || a.some((x, j) => Math.abs(x - b[j]!) >= ADJUSTED_S)
    ) {
      const t0 = Math.min(a[0]!, b[0]!);
      const t1 = Math.max(a[a.length - 1]!, b[b.length - 1]!);
      const last = spans[spans.length - 1];
      if (last && t0 <= last[1] + 1) last[1] = Math.max(last[1], t1);
      else spans.push([t0, t1]);
    }
  }
  return spans;
}

function hopWait(it: MoveItem, w: SignalWait, hop: number): HopWait {
  return { hop, d: r1(w.g - it.g0), t0: r1(w.t0), t1: r1(w.t1), why: w.why };
}

function packVia(pts: [number, number][]): number[] {
  return pts.flatMap(([t, d]) => [r1(t), r1(d)]);
}

function pieceFor(route: RoutePiece[], G: number): RoutePiece {
  let lo = 0;
  let hi = route.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (route[mid]!.g0 <= G) lo = mid;
    else hi = mid - 1;
  }
  return route[lo]!;
}
