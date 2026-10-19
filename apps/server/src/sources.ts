// The regions, operators and feeds tables follow config/regions/*/region.json,
// config/operators/*/operator.json and config/feeds/*/feed.json (docs/DESIGN.md#regions-and-feeds):
// rows of a feed reference it, and a feed its operator, so anything that writes them (the server,
// the import, statistics and features tools) syncs these first.

import type { Db } from "@transitopia/db/connect.ts";
import type { FeedInfo, RegionInfo } from "@transitopia/transit-core/config.ts";
import {
  readFeeds,
  readOperators,
  readRegions,
} from "@transitopia/data/paths.ts";

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
  for (const o of await readOperators())
    await db
      .insertInto("operators")
      .values({ id: o.id, name: o.name })
      .onConflict((oc) => oc.column("id").doUpdateSet({ name: o.name }))
      .execute();
  for (const f of feeds ?? (await readFeeds())) {
    const row = {
      name: f.name,
      operator_id: f.operator,
      timezone: f.timezone,
    };
    await db
      .insertInto("feeds")
      .values({ id: f.id, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row))
      .execute();
  }
}
