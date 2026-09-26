// Infer train runs and build movement files for every service-day type of every built feed
// (PLAN.md §4.3–4.4):
//   public/data/feeds/<version>/movements/<services>.json
//   public/data/feeds/<version>/movements/index.json
//
//   npm run build:movements [-- --verbose]

import { join } from 'node:path';
import { CONFIG_DIR, FEEDS_OUT_DIR, readJson } from './lib/paths.ts';
import { loadAllPlans, loadGraph } from './lib/infra.ts';
import { buildAllMovements } from './lib/movements.ts';
import { mapPlatforms } from '../src/core/infra/platforms.ts';
import type { OperationsConfig } from '../src/core/movement/build.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';

async function main() {
  const { graph, overrides } = await loadGraph();
  const kin = await readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json'));
  const ops = await readJson<OperationsConfig>(join(CONFIG_DIR, 'operations.json'));
  for (const plan of await loadAllPlans()) {
    const railKeys = new Set(plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
    const report = mapPlatforms(graph, plan, railKeys, overrides.platforms);
    await buildAllMovements({
      plan,
      graph,
      platforms: report.assignments,
      kin,
      ops,
      outDir: join(FEEDS_OUT_DIR, plan.feedVersion, 'movements'),
      relDir: `data/feeds/${plan.feedVersion}/movements`,
      verbose: process.argv.includes('--verbose'),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
