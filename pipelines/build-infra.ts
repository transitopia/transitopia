// Publish the track network and per-feed platform mapping for the browser (packages/transit-core/DESIGN.md#track-graph):
//   var/public/data/networks/<network>/infra/tracks.geojson   segments, nodes, stop positions
//   var/public/data/networks/<network>/infra/lines.geojson    line centrelines and ribbons, for drawing
//   var/public/data/feeds/<rail feed>/<version>/platforms.json   GTFS stop_id → track position
//
//   npm run build:infra [-- --network skytrain]

import { join } from "node:path";
import {
  feedVersionFile,
  log,
  networkDataDir,
  writeJson,
  railNetworksArg,
  railFeedConfig,
  readNetworkConfig,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import { loadAllPlans, loadGraph } from "@transitopia/data/infra.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";
import {
  lineGeometry,
  serviceExtents,
  type ServiceExtents,
} from "@transitopia/transit-core/infra/line-geometry.ts";

export interface PlatformsFile {
  feedVersion: string;
  platforms: Record<
    string,
    { seg: string; offset: number; dist: number; method: string }
  >;
}

/** One rail network (railNetworks: a network and a feed with track-level rail on it). */
async function buildNetwork(net: RailNetwork) {
  const infraDir = join(networkDataDir(net.network), "infra");
  const { graph, overrides, tracks } = await loadGraph(net.network);
  await writeJson(join(infraDir, "tracks.geojson"), tracks);
  log(`Wrote infra/tracks.geojson (${graph.segments.size} segments)`);
  // Service track: where any feed version's trains run.
  const service: ServiceExtents = new Map();
  const kin = (await railFeedConfig(net)).kinematics;
  const ops = await readNetworkConfig("operations", net.network);
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
    const out: PlatformsFile = { feedVersion: plan.feedVersion, platforms: {} };
    for (const a of report.assignments.values()) {
      out.platforms[a.stopId] = {
        seg: a.pos.seg,
        offset: Math.round(a.pos.offset * 100) / 100,
        dist: Math.round(a.dist * 10) / 10,
        method: a.method,
      };
    }
    await writeJson(
      feedVersionFile(net.feed, plan.feedVersion, "platforms.json"),
      out,
    );
    log(
      `Feed ${plan.feedVersion}: ${report.assignments.size} platforms mapped, ${report.breaks.length} breaks`,
    );
    serviceExtents(
      {
        graph,
        plan,
        routeKeys: railKeys,
        platforms: report.assignments,
        patternPositions: report.patternPositions,
        kin,
        maxPullUpM: ops.turnback.maxPullUpM,
      },
      service,
    );
  }
  await writeJson(
    join(infraDir, "lines.geojson"),
    lineGeometry(tracks, service),
  );
  log("Wrote infra/lines.geojson");
}

async function main() {
  for (const net of await railNetworksArg()) await buildNetwork(net);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
