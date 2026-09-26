// Build movement files for every service-day type of a plan (shared by build-movements and scenario).

import { join } from 'node:path';
import { log, writeJson } from './paths.ts';
import type { TrackGraph, TrackPos } from '../../src/core/infra/graph.ts';
import type { PlatformAssignment } from '../../src/core/infra/platforms.ts';
import { preparePlan } from '../../src/core/schedule/engine.ts';
import { buildMovements, type OperationsConfig } from '../../src/core/movement/build.ts';
import { serviceKey, type MovementsFile, type MovementsIndex } from '../../src/core/movement/types.ts';
import type { KinematicsConfig } from '../../src/core/movement/kinematics.ts';
import type { ServicePlan } from '../../src/core/plan/types.ts';
import { addDays } from '../../src/core/time.ts';

export interface BuildAllInput {
  plan: ServicePlan;
  graph: TrackGraph;
  platforms: Map<string, PlatformAssignment>;
  patternPositions?: Map<number, Map<number, TrackPos>>;
  kin: KinematicsConfig;
  ops: OperationsConfig;
  /** Absolute output directory for movement files. */
  outDir: string;
  /** Path of outDir relative to public/, for the index. */
  relDir: string;
  verbose?: boolean;
}

export async function buildAllMovements(input: BuildAllInput): Promise<{ index: MovementsIndex; files: Map<string, MovementsFile> }> {
  const { plan, graph, platforms, patternPositions, kin, ops } = input;
  const pp = preparePlan(plan, kin);
  const railKeys = new Set(plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
  const railServices = new Set(plan.trips.filter((t) => railKeys.has(plan.patterns[t.pattern]!.route)).map((t) => t.service));

  // Distinct sets of active rail services across the feed's dates.
  const sets = new Map<string, { services: Set<string>; dates: string[] }>();
  for (let d = plan.feedStart; d <= plan.feedEnd; d = addDays(d, 1)) {
    const active = new Set([...pp.servicesOn(d)].filter((s) => railServices.has(s)));
    if (!active.size) continue;
    const key = serviceKey(active);
    (sets.get(key) ?? sets.set(key, { services: active, dates: [] }).get(key)!).dates.push(d);
  }

  const index: MovementsIndex = { schema: 1, feedVersion: plan.feedVersion, files: {} };
  const files = new Map<string, MovementsFile>();
  for (const [key, { services, dates }] of sets) {
    const t0 = performance.now();
    const file = buildMovements({ graph, pp, platforms, patternPositions, services, ops, kin });
    await writeJson(join(input.outDir, `${key}.json`), file);
    index.files[key] = `${input.relDir}/${key}.json`;
    files.set(key, file);
    if (input.verbose) {
      for (const [st, v] of Object.entries(file.stats.termini)) console.log(`    ${st.padEnd(32)} chained ${v.chained}, unchained ${v.unchained} ${JSON.stringify(v.reasons)}`);
    }
    const peaks = Object.entries(file.stats.peakInService)
      .map(([l, n]) => `${l} ${n}`)
      .join(', ');
    log(
      `${plan.feedVersion} [${key}] ${dates.length} days (e.g. ${dates[0]}): ${file.stats.trips} trips → ${file.stats.runs} runs; ` +
        `peak in service: ${peaks}; unplaced ${file.stats.unplacedTrips}; ${Math.round(performance.now() - t0)} ms`,
    );
  }
  await writeJson(join(input.outDir, 'index.json'), index, true);
  return { index, files };
}
