// Dispatch one service date with its inputs (PLAN.md §4.11): the shared step behind static patches
// (npm run build:dispatch) and live dispatch in the RT service. Pure and deterministic.

import type { TrackGraph } from '../infra/graph.ts';
import type { KinematicsConfig } from '../movement/kinematics.ts';
import type { MovementsFile } from '../movement/types.ts';
import type { PreparedPlan } from '../schedule/engine.ts';
import { railInputs } from '../corrections/reconcile.ts';
import type { Observation } from '../corrections/types.ts';
import { dispatch, type DispatchConfig } from './dispatch.ts';
import { inputsVersion, makePatch, type DispatchPatch } from './patch.ts';

export interface DateInputs {
  /** Service date, YYYYMMDD. */
  date: string;
  observations: Observation[];
}

export interface DateContext {
  pp: PreparedPlan;
  graph: TrackGraph;
  /** The inferred (undispatched) runs for the date's service key, and their dispatched base. */
  inferred: MovementsFile;
  base: MovementsFile;
  config: DispatchConfig;
  kin: KinematicsConfig;
  deadheadSpeedFactor: number;
  turnbackSpeedFactor: number;
}

/** Content version of a date's inputs (and the base they apply to). */
export function dateVersion(ctx: Pick<DateContext, 'base' | 'config'>, inputs: DateInputs): string {
  return inputsVersion({ base: ctx.base.builtAt, services: ctx.base.services, config: ctx.config, date: inputs.date, observations: inputs.observations });
}

export function dispatchDate(ctx: DateContext, inputs: DateInputs, builtAt: string): DispatchPatch {
  const rail = railInputs(ctx.inferred, ctx.pp, inputs.observations, inputs.date);
  const labels: string[] = [];
  const nObs = rail.used;
  if (nObs) labels.push(`${nObs} observation${nObs === 1 ? '' : 's'}`);
  const out = dispatch(ctx.inferred, ctx.pp, ctx.graph, {
    config: ctx.config,
    kin: ctx.kin,
    deadheadSpeedFactor: ctx.deadheadSpeedFactor,
    turnbackSpeedFactor: ctx.turnbackSpeedFactor,
    inputs: labels,
    date: inputs.date,
    rail,
    base: ctx.base,
  });
  return makePatch(ctx.base, out, { date: inputs.date, version: dateVersion(ctx, inputs), builtAt, unmatched: rail.unmatched });
}
