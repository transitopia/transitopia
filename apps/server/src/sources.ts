// The regions and feeds tables follow regions/*/region.json and feeds/*/feed.json
// (docs/DESIGN.md#regions-and-feeds): rows of a feed reference it, so anything that writes them
// (the server, the import and statistics tools) syncs these first.

import type { Db } from "@transitopia/db/connect.ts";
import type { FeedInfo, RegionInfo } from "@transitopia/transit-core/config.ts";
import { readFeeds, readRegions } from "@transitopia/data/paths.ts";

export async function syncSources(
  db: Db,
  regions?: RegionInfo[],
  feeds?: FeedInfo[],
): Promise<void> {
  for (const r of regions ?? (await readRegions())) {
    const row = { name: r.name, timezone: r.timezone };
    await db
      .insertInto("regions")
      .values({ id: r.id, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row))
      .execute();
  }
  for (const f of feeds ?? (await readFeeds())) {
    const row = { name: f.name, agency: f.agency, timezone: f.timezone };
    await db
      .insertInto("feeds")
      .values({ id: f.id, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row))
      .execute();
  }
}
