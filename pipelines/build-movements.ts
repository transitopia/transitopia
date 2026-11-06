// Infer train runs and build movement files for every service-day type of every built feed
// (packages/transit-core/DESIGN.md#run-inference):
//   var/public/data/feeds/<rail feed>/<version>/movements/<services>.json
//   var/public/data/feeds/<rail feed>/<version>/movements/index.json
//
//   npm run build:movements [-- --verbose] [--no-dispatch] [--force] [--network skytrain]
//
// Movements are dispatched (signalling-aware, packages/transit-core/DESIGN.md#dispatcher) unless --no-dispatch.
// A version's movements record what they were built from (`inputs`: the plan's rail content, the
// track graph and its overrides, the settings and the code that builds them); while that's the same
// they're kept as they are, builtAt included, so dispatch patches made against them still fit.
// --force rebuilds them anyway.

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import {
  ROOT,
  exists,
  feedVersionFile,
  log,
  readJson,
  readNetworkConfig,
  railFeedConfig,
  railNetworksArg,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import {
  feedDataPath,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type { MovementsIndex } from "@transitopia/transit-core/movement/types.ts";
import { loadAllPlans, loadGraph } from "@transitopia/data/infra.ts";
import { buildAllMovements } from "./lib/movements.ts";
import { sourceHash } from "./lib/source-hash.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";

/**
 * The code behind movement files and what's built on them: this script, and dispatching a date
 * (build:dispatch, the live dispatcher and the contexts both load), whose patches only fit the base
 * they were made against and are reused while its builtAt and their inputs are the same.
 */
const CODE = [
  import.meta.filename,
  join(ROOT, "pipelines/build-dispatch.ts"),
  join(ROOT, "packages/data/src/dispatch-context.ts"),
  join(ROOT, "packages/transit-core/src/dispatch/date.ts"),
];

/**
 * What of a plan its movements depend on: its rail routes, their patterns (with their ids: movement
 * files refer to them), stops, shapes and trips, the services those run on, and its stations.
 * Bus-only changes leave it the same.
 */
function railContent(plan: ServicePlan): unknown {
  const routes = plan.routes.filter((r) => r.kind === "skytrain");
  const keys = new Set(routes.map((r) => r.key));
  const patterns = plan.patterns.filter((p) => keys.has(p.route));
  const ids = new Set(patterns.map((p) => p.id));
  const trips = plan.trips.filter((t) => ids.has(t.pattern));
  const services = new Set(trips.map((t) => t.service));
  const stops = [...new Set(patterns.flatMap((p) => p.stops))].sort(
    (a, b) => a - b,
  );
  return {
    feedVersion: plan.feedVersion,
    feedStart: plan.feedStart,
    feedEnd: plan.feedEnd,
    timezone: plan.timezone,
    routes,
    patterns,
    stops: stops.map((i) => [i, plan.stops[i]]),
    shapes: patterns.map((p) => [p.shape, plan.shapes[p.shape]]),
    stations: plan.stations,
    trips,
    calendar: plan.calendar.calendar.filter((c) => services.has(c.serviceId)),
    exceptions: plan.calendar.exceptions.filter((e) =>
      services.has(e.serviceId),
    ),
  };
}

/** Whether every movement file `index` lists is on disk (and its inferred runs, when dispatched). */
async function filesExist(
  index: MovementsIndex,
  outDir: string,
  dispatched: boolean,
): Promise<boolean> {
  for (const path of Object.values(index.files)) {
    const name = basename(path);
    if (!(await exists(join(outDir, name)))) return false;
    if (dispatched && !(await exists(join(outDir, "inferred", name))))
      return false;
  }
  return true;
}

/** One rail network (railNetworks: a network and a feed with track-level rail on it). */
async function buildNetwork(net: RailNetwork, code: string) {
  const { graph, overrides, tracks } = await loadGraph(net.network);
  const kin = (await railFeedConfig(net)).kinematics;
  const ops = await readNetworkConfig("operations", net.network);
  const dispatchCfg =
    process.argv.includes("--no-dispatch") ?
      undefined
    : await readNetworkConfig("dispatch", net.network);
  const shared = createHash("sha256")
    .update(
      JSON.stringify({
        code,
        tracks,
        overrides,
        kin,
        ops,
        dispatch: dispatchCfg ?? null,
      }),
    )
    .digest("hex");
  for (const plan of await loadAllPlans(net.feed)) {
    const inputs = createHash("sha256")
      .update(shared)
      .update(JSON.stringify(railContent(plan)))
      .digest("hex")
      .slice(0, 16);
    const outDir = feedVersionFile(net.feed, plan.feedVersion, "movements");
    const was = await readJson<MovementsIndex>(
      join(outDir, "index.json"),
    ).catch(() => undefined);
    if (
      !process.argv.includes("--force")
      && was?.inputs === inputs
      && (await filesExist(was, outDir, dispatchCfg !== undefined))
    ) {
      log(`${plan.feedVersion}: movements up to date (use --force to rebuild)`);
      continue;
    }
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
      outDir,
      relDir: feedDataPath(net.feed, plan.feedVersion, "movements"),
      inputs,
      verbose: process.argv.includes("--verbose"),
    });
  }
}

async function main() {
  const code = await sourceHash(CODE);
  for (const net of await railNetworksArg()) await buildNetwork(net, code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
