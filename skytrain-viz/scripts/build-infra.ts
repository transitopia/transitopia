// Publish the track network and per-feed platform mapping for the browser (PLAN.md §4.1):
//   public/data/infra/tracks.geojson                 segments, nodes, stop positions
//   public/data/feeds/<version>/platforms.json       GTFS stop_id → track position
//
//   npm run build:infra

import { join } from 'node:path';
import { PUBLIC_DATA_DIR, FEEDS_OUT_DIR, log, writeJson } from './lib/paths.ts';
import { loadAllPlans, loadGraph } from './lib/infra.ts';
import { mapPlatforms } from '../src/core/infra/platforms.ts';

export interface PlatformsFile {
  feedVersion: string;
  platforms: Record<string, { seg: string; offset: number; dist: number; method: string }>;
}

async function main() {
  const { graph, overrides, tracks } = await loadGraph();
  await writeJson(join(PUBLIC_DATA_DIR, 'infra', 'tracks.geojson'), tracks);
  log(`Wrote infra/tracks.geojson (${graph.segments.size} segments)`);
  for (const plan of await loadAllPlans()) {
    const railKeys = new Set(plan.routes.filter((r) => r.kind === 'skytrain').map((r) => r.key));
    const report = mapPlatforms(graph, plan, railKeys, overrides.platforms);
    const out: PlatformsFile = { feedVersion: plan.feedVersion, platforms: {} };
    for (const a of report.assignments.values()) {
      out.platforms[a.stopId] = { seg: a.pos.seg, offset: Math.round(a.pos.offset * 100) / 100, dist: Math.round(a.dist * 10) / 10, method: a.method };
    }
    await writeJson(join(FEEDS_OUT_DIR, plan.feedVersion, 'platforms.json'), out);
    log(`Feed ${plan.feedVersion}: ${report.assignments.size} platforms mapped, ${report.breaks.length} breaks`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
