// Infer train runs and build movement files for every service-day type of every built feed
// (packages/transit-core/DESIGN.md#run-inference):
//   var/public/data/feeds/<rail feed>/<version>/movements/<services>.json
//   var/public/data/feeds/<rail feed>/<version>/movements/index.json
//
//   npm run build:movements [-- --verbose] [--no-dispatch]
//
// Movements are dispatched (signalling-aware, packages/transit-core/DESIGN.md#dispatcher) unless --no-dispatch.

import {
  feedVersionFile,
  readConfig,
  railFeedConfig,
  railNetworks,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import { feedDataPath } from "@transitopia/transit-core/plan/types.ts";
import { loadAllPlans, loadGraph } from "@transitopia/data/infra.ts";
import { buildAllMovements } from "./lib/movements.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";

/** One rail network (railNetworks: a feed with track-level rail, in its region). */
async function buildNetwork(net: RailNetwork) {
  const { graph, overrides } = await loadGraph(net.region);
  const kin = (await railFeedConfig(net)).kinematics;
  const ops = await readConfig("operations", net.region);
  const dispatchCfg =
    process.argv.includes("--no-dispatch") ?
      undefined
    : await readConfig("dispatch", net.region);
  for (const plan of await loadAllPlans(net.feed)) {
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
      outDir: feedVersionFile(net.feed, plan.feedVersion, "movements"),
      relDir: feedDataPath(net.feed, plan.feedVersion, "movements"),
      verbose: process.argv.includes("--verbose"),
    });
  }
}

async function main() {
  for (const net of await railNetworks()) await buildNetwork(net);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
