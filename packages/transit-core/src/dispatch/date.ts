// Dispatch one service date with its inputs (PLAN.md §4.11): the shared step behind static patches
// (npm run build:dispatch) and live dispatch in the RT service. Pure and deterministic.
//
// Observations alone re-dispatch the date's inferred runs (a patch of the runs that changed).
// Disruptions change the plan itself (rerouted and cancelled trips), so the date is re-inferred
// first and the patch carries the whole day's plan.

import type { TrackGraph, TrackPos } from '../infra/graph.ts';
import type { PlatformAssignment } from '../infra/platforms.ts';
import type { KinematicsConfig } from '../movement/kinematics.ts';
import { buildMovements, type OperationsConfig } from '../movement/build.ts';
import type { MovementsFile, Run } from '../movement/types.ts';
import { preparePlan, type PreparedPlan } from '../schedule/engine.ts';
import { railInputs } from '../corrections/reconcile.ts';
import type { Observation } from '../corrections/types.ts';
import { applyDisruptions, periodsOn } from '../disruption/apply.ts';
import type { Disruption } from '../disruption/types.ts';
import { dispatchAsync, type DispatchConfig } from './dispatch.ts';
import { inputsVersion, makePatch, type DispatchPatch } from './patch.ts';

export interface DateInputs {
  /** Service date, YYYYMMDD. */
  date: string;
  observations: Observation[];
  disruptions?: Disruption[];
}

export interface DateContext {
  pp: PreparedPlan;
  graph: TrackGraph;
  /** The inferred (undispatched) runs for the date's service key, and their dispatched base. */
  inferred: MovementsFile;
  base: MovementsFile;
  config: DispatchConfig;
  kin: KinematicsConfig;
  ops: OperationsConfig;
  /** Platform mapping, for re-inferring a disrupted date. */
  platforms: Map<string, PlatformAssignment>;
  patternPositions?: Map<number, Map<number, TrackPos>>;
}

/** Disruptions that apply on the date (confirmed, with a period touching its service day). */
export function activeDisruptions(inputs: DateInputs): Disruption[] {
  return (inputs.disruptions ?? []).filter((d) => d.status !== 'draft' && periodsOn(d, inputs.date).length > 0);
}

/** Content version of a date's inputs (and the base they apply to). */
export function dateVersion(ctx: Pick<DateContext, 'base' | 'config'>, inputs: DateInputs): string {
  return inputsVersion({ base: ctx.base.builtAt, services: ctx.base.services, config: ctx.config, date: inputs.date, observations: inputs.observations, disruptions: activeDisruptions(inputs) });
}

/** Dispatch a date with its inputs (yields to the event loop while it simulates). */
export async function dispatchDate(ctx: DateContext, inputs: DateInputs, builtAt: string): Promise<DispatchPatch> {
  const version = dateVersion(ctx, inputs);
  const disruptions = activeDisruptions(inputs);
  const speeds = { deadheadSpeedFactor: ctx.ops.yard.deadheadSpeedFactor, turnbackSpeedFactor: ctx.ops.turnback.speedFactor };
  if (!disruptions.length) {
    const rail = railInputs(ctx.inferred, ctx.pp, inputs.observations, inputs.date);
    const out = await dispatchAsync(ctx.inferred, ctx.pp, ctx.graph, { config: ctx.config, kin: ctx.kin, ...speeds, inputs: labels(rail.used, []), date: inputs.date, rail, base: ctx.base });
    return makePatch(ctx.base, out, { date: inputs.date, version, builtAt, unmatched: rail.unmatched });
  }
  // Re-infer the day with the disruptions applied, then dispatch it with the observations.
  const services = new Set(ctx.base.services);
  const day = applyDisruptions({
    plan: ctx.pp.plan,
    graph: ctx.graph,
    platforms: ctx.platforms,
    ...(ctx.patternPositions ? { patternPositions: ctx.patternPositions } : {}),
    services,
    date: inputs.date,
    disruptions,
    singleTrackHeadwayS: ctx.config.singleTrackHeadwayS,
  });
  const pp = preparePlan(day.plan, ctx.kin);
  const inferred = buildMovements({ graph: ctx.graph, pp, platforms: ctx.platforms, patternPositions: day.patternPositions, services, ops: ctx.ops, kin: ctx.kin, closures: day.closures });
  const rail = railInputs(inferred, pp, inputs.observations, inputs.date);
  const out = await dispatchAsync(inferred, pp, ctx.graph, { config: ctx.config, kin: ctx.kin, ...speeds, inputs: labels(rail.used, disruptions), date: inputs.date, rail });
  // Trains on a disrupted line carry the notice while it applies.
  for (const run of out.runs) {
    const span = runSpan(run, pp);
    for (const n of day.notices) {
      if (!n.lines.includes(run.line) || span[1] < n.from || span[0] > n.to) continue;
      (run.notes ??= []).push({ t0: Math.max(n.from, span[0]), t1: Math.min(n.to, span[1]), text: `${n.text} (${n.source})` });
    }
  }
  const patch = makePatch(ctx.base, out, { date: inputs.date, version, builtAt, unmatched: rail.unmatched });
  return { ...patch, runs: [], file: out, notices: day.notices, ...(day.problems.length ? { problems: day.problems } : {}), summary: { ...patch.summary, inputs: [...patch.summary.inputs, ...(day.cancelled.length ? [`${day.cancelled.length} trips cancelled`] : [])] } };
}

function labels(observations: number, disruptions: Disruption[]): string[] {
  const out: string[] = [];
  if (observations) out.push(`${observations} observation${observations === 1 ? '' : 's'}`);
  for (const d of disruptions) out.push(d.text);
  return out;
}

function runSpan(run: Run, pp: PreparedPlan): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (const e of run.events) {
    if (e.k === 'trip') {
      const t = pp.tripIndex.get(e.trip)!;
      a = Math.min(a, e.times?.[1] ?? t.dep[0]!);
      b = Math.max(b, e.times?.[e.times.length - 2] ?? t.arr[t.arr.length - 1]!);
    } else {
      a = Math.min(a, e.t0);
      b = Math.max(b, e.t1);
    }
  }
  return [a, b];
}
