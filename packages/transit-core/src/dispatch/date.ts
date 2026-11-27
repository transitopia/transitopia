// Dispatch one service date with its inputs (packages/transit-core/DESIGN.md#dispatcher): the shared step behind static patches
// (npm run build:dispatch) and live dispatch in the RT service. Pure and deterministic.
//
// Observations re-dispatch the date's inferred runs (a patch of the runs that changed).

import type { ServiceDate } from "../time.ts";
import type { TrackGraph } from "../infra/graph.ts";
import type { KinematicsConfig } from "../movement/kinematics.ts";
import type { OperationsConfig } from "../movement/build.ts";
import type { MovementsFile } from "../movement/types.ts";
import type { PreparedPlan } from "../schedule/engine.ts";
import { railInputs } from "../corrections/reconcile.ts";
import type { Observation } from "../corrections/types.ts";
import {
  dispatchAsync,
  type DispatchConfig,
  type DispatchDebug,
} from "./dispatch.ts";
import { inputsVersion, makePatch, type DispatchPatch } from "./patch.ts";

export interface DateInputs {
  /** Service date, YYYYMMDD. */
  date: ServiceDate;
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
  ops: OperationsConfig;
  /** The dispatcher's debug output (not part of the date's version). */
  debug?: DispatchDebug | undefined;
}

/** Content version of a date's inputs (and the base they apply to). */
export function dateVersion(
  ctx: Pick<DateContext, "base" | "config">,
  inputs: DateInputs,
): string {
  return inputsVersion({
    base: ctx.base.builtAt,
    services: ctx.base.services,
    config: ctx.config,
    date: inputs.date,
    observations: inputs.observations,
  });
}

/** Dispatch a date with its inputs (yields to the event loop while it simulates). */
export async function dispatchDate(
  ctx: DateContext,
  inputs: DateInputs,
  builtAt: string,
): Promise<DispatchPatch> {
  const version = dateVersion(ctx, inputs);
  const rail = railInputs(
    ctx.inferred,
    ctx.pp,
    inputs.observations,
    inputs.date,
  );
  const out = await dispatchAsync(ctx.inferred, ctx.pp, ctx.graph, {
    config: ctx.config,
    kin: ctx.kin,
    deadheadSpeedFactor: ctx.ops.yard.deadheadSpeedFactor,
    turnbackSpeedFactor: ctx.ops.turnback.speedFactor,
    inputs:
      rail.used ?
        [`${rail.used} observation${rail.used === 1 ? "" : "s"}`]
      : [],
    date: inputs.date,
    rail,
    base: ctx.base,
    debug: ctx.debug,
  });
  return makePatch(ctx.base, out, {
    date: inputs.date,
    version,
    builtAt,
    unmatched: rail.unmatched,
  });
}
