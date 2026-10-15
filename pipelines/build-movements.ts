// Infer train runs and build movement files for every service-day type of every built feed
// (packages/transit-core/DESIGN.md#run-inference):
//   var/public/data/feeds/<rail feed>/<version>/movements/<services>.json
//   var/public/data/feeds/<rail feed>/<version>/movements/index.json
//
//   npm run build:movements [-- --verbose] [--no-dispatch]
//
// Movements are dispatched (signalling-aware, packages/transit-core/DESIGN.md#dispatcher) unless --no-dispatch.

import {
  RAIL_FEED,
  feedVersionFile,
  readConfig,
  railFeedConfig,
} from "@transitopia/data/paths.ts";
import { feedDataPath } from "@transitopia/transit-core/plan/types.ts";
import { loadAllPlans, loadGraph } from "@transitopia/data/infra.ts";
import { buildAllMovements } from "./lib/movements.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";

async function main() {
  const { graph, overrides } = await loadGraph();
  const kin = (await railFeedConfig()).kinematics;
  const ops = await readConfig("operations");
  const dispatchCfg =
    process.argv.includes("--no-dispatch") ?
      undefined
    : await readConfig("dispatch");
  for (const plan of await loadAllPlans()) {
    const railKeys = new Set(
      plan.routes.filter((r) => r.kind === "skytrain").map((r) => r.key),
    );
    const report = mapPlatforms(
      graph,
      plan,
      railKeys,
      overrides.platforms,
      overrides.patternPlatforms,
    );
    await buildAllMovements({
      plan,
      graph,
      platforms: report.assignments,
      patternPositions: report.patternPositions,
      kin,
      ops,
      ...(dispatchCfg ? { dispatch: dispatchCfg } : {}),
      outDir: feedVersionFile(RAIL_FEED, plan.feedVersion, "movements"),
      relDir: feedDataPath(RAIL_FEED, plan.feedVersion, "movements"),
      verbose: process.argv.includes("--verbose"),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
