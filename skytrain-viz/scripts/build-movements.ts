// Infer train runs and build movement files for every service-day type of every built feed
// (PLAN.md §4.3–4.4):
//   public/data/feeds/<version>/movements/<services>.json
//   public/data/feeds/<version>/movements/index.json
//
//   npm run build:movements

import { join } from 'node:path';
import { CONFIG_DIR, FEEDS_OUT_DIR, log, readJson, writeJson } from './lib/paths.ts';
import { loadAllPlans, loadGraph } from './lib/infra.ts';
import { mapPlatforms } from '../src/core/infra/platforms.ts';
import { preparePlan } from '../src/core/schedule/engine.ts';
import { buildMovements, type OperationsConfig } from '../src/core/movement/build.ts';
import { serviceKey, type MovementsIndex } from '../src/core/movement/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';
import { addDays } from '../src/core/time.ts';

async function main() {
  const { graph, overrides } = await loadGraph();
  const kin = await readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json'));
  const ops = await readJson<OperationsConfig>(join(CONFIG_DIR, 'operations.json'));
  for (const plan of await loadAllPlans()) {
    const pp = preparePlan(plan, kin);
    const railKeys = new Set(plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
    const railServices = new Set(plan.trips.filter((t) => railKeys.has(plan.patterns[t.pattern]!.route)).map((t) => t.service));
    const report = mapPlatforms(graph, plan, railKeys, overrides.platforms);

    // Distinct sets of active rail services across the feed's dates.
    const sets = new Map<string, { services: Set<string>; dates: string[] }>();
    for (let d = plan.feedStart; d <= plan.feedEnd; d = addDays(d, 1)) {
      const active = new Set([...pp.servicesOn(d)].filter((s) => railServices.has(s)));
      if (!active.size) continue;
      const key = serviceKey(active);
      (sets.get(key) ?? sets.set(key, { services: active, dates: [] }).get(key)!).dates.push(d);
    }

    const index: MovementsIndex = { schema: 1, feedVersion: plan.feedVersion, files: {} };
    for (const [key, { services, dates }] of sets) {
      const t0 = performance.now();
      const file = buildMovements({ graph, pp, platforms: report.assignments, services, ops, kin });
      const rel = `data/feeds/${plan.feedVersion}/movements/${key}.json`;
      await writeJson(join(FEEDS_OUT_DIR, plan.feedVersion, 'movements', `${key}.json`), file);
      index.files[key] = rel;
      const peaks = Object.entries(file.stats.peakInService)
        .map(([l, n]) => `${l} ${n}`)
        .join(', ');
      if (process.argv.includes('--verbose')) {
        for (const [st, v] of Object.entries(file.stats.termini)) console.log(`    ${st.padEnd(32)} chained ${v.chained}, unchained ${v.unchained} ${JSON.stringify(v.reasons)}`);
      }
      log(
        `${plan.feedVersion} [${key}] ${dates.length} days (e.g. ${dates[0]}): ${file.stats.trips} trips → ${file.stats.runs} runs; ` +
          `peak in service: ${peaks}; unplaced ${file.stats.unplacedTrips}; ${Math.round(performance.now() - t0)} ms`,
      );
    }
    await writeJson(join(FEEDS_OUT_DIR, plan.feedVersion, 'movements', 'index.json'), index, true);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
