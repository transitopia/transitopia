// Make each plan's tiles (packages/transit-core/DESIGN.md#plan-tiles): every line the map draws for it,
// with SkyTrain's track in a region with track-level rail (build-infra's tracks.geojson and
// lines.geojson). Tiles are named by a hash of their input, so a plan whose lines didn't change
// reuses those it has; plan.json names them. Tiles no plan names any more are removed.
// Input:  var/public/data/feeds/<feed>/<version dir>/plan.json and its parts,
//         var/public/data/regions/<rail region>/infra/{tracks,lines}.geojson
// Output: var/public/data/feeds/<feed>/lines/<hash>.pmtiles, and plan.json's `files.tiles`
//
//   tsx pipelines/build-plan-tiles.ts                   # every feed
//   tsx pipelines/build-plan-tiles.ts --feed translink  # one feed

import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  exists,
  feedPaths,
  log,
  railNetworks,
  readFeed,
  readFeeds,
  readJson,
  regionDataDir,
} from "@transitopia/data/paths.ts";
import { readPlanLines, writePlanTiles } from "@transitopia/data/plan-tiles.ts";
import type { RailInput } from "@transitopia/transit-core/plan/tiles.ts";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import type { LineGeometry } from "@transitopia/transit-core/infra/line-geometry.ts";

/** A feed's track-level rail, where its region has published it (build-infra). */
async function railOf(feed: string): Promise<RailInput | undefined> {
  const net = (await railNetworks()).find((n) => n.feed === feed);
  if (!net) return undefined;
  const infra = join(regionDataDir(net.region), "infra");
  const tracks = join(infra, "tracks.geojson");
  const lines = join(infra, "lines.geojson");
  if (!(await exists(tracks)) || !(await exists(lines))) {
    log(
      `${feed}: no published track (npm run build:infra); SkyTrain drawn along its GTFS shapes`,
    );
    return undefined;
  }
  return {
    tracks: await readJson<InfraCollection>(tracks),
    lines: await readJson<LineGeometry>(lines),
  };
}

async function buildFeed(feed: string): Promise<void> {
  const out = feedPaths(feed).out;
  const dir = join(out, "lines");
  const rail = await railOf(feed);
  const used = new Set<string>();
  let built = 0;
  let plans = 0;
  for (const v of (await exists(out)) ? (await readdir(out)).sort() : []) {
    const planPath = join(out, v, "plan.json");
    if (!(await exists(planPath))) continue;
    const plan = await readPlanLines(planPath);
    const t = await writePlanTiles(planPath, plan, dir, rail);
    used.add(resolve(out, v, t.path));
    plans++;
    if (t.built) {
      built++;
      log(`${feed} ${v}: made ${t.path}`);
    }
  }
  let removed = 0;
  for (const f of (await exists(dir)) ? await readdir(dir) : [])
    if (f.endsWith(".pmtiles") && !used.has(resolve(dir, f))) {
      await rm(join(dir, f));
      removed++;
    }
  log(
    `${feed}: tiles for ${plans} plans (${built} made, ${plans - built} reused${removed ? `, ${removed} unused removed` : ""})`,
  );
}

async function main() {
  const i = process.argv.indexOf("--feed");
  const only = i >= 0 ? process.argv[i + 1] : undefined;
  for (const feed of only ? [await readFeed(only)] : await readFeeds())
    await buildFeed(feed.id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
