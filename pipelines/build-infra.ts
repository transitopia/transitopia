// Publish the track network and per-feed platform mapping for the browser (packages/transit-core/DESIGN.md#track-graph):
//   var/public/data/regions/<rail region>/infra/tracks.geojson   segments, nodes, stop positions
//   var/public/data/regions/<rail region>/infra/lines.geojson    line centrelines and ribbons, for drawing
//   var/public/data/feeds/<rail feed>/<version>/platforms.json   GTFS stop_id → track position
//
//   npm run build:infra

import { join } from "node:path";
import {
  feedVersionFile,
  log,
  regionDataDir,
  writeJson,
  railNetworks,
  type RailNetwork,
} from "@transitopia/data/paths.ts";
import { loadAllPlans, loadGraph } from "@transitopia/data/infra.ts";
import { mapPlatforms } from "@transitopia/transit-core/infra/platforms.ts";
import { lineGeometry } from "@transitopia/transit-core/infra/line-geometry.ts";

export interface PlatformsFile {
  feedVersion: string;
  platforms: Record<
    string,
    { seg: string; offset: number; dist: number; method: string }
  >;
}

/** One rail network (railNetworks: a feed with track-level rail, in its region). */
async function buildNetwork(net: RailNetwork) {
  const { graph, overrides, tracks } = await loadGraph(net.region);
  await writeJson(
    join(regionDataDir(net.region), "infra", "tracks.geojson"),
    tracks,
  );
  log(`Wrote infra/tracks.geojson (${graph.segments.size} segments)`);
  await writeJson(
    join(regionDataDir(net.region), "infra", "lines.geojson"),
    lineGeometry(tracks),
  );
  log("Wrote infra/lines.geojson");
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
  }
}

async function main() {
  for (const net of await railNetworks()) await buildNetwork(net);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
