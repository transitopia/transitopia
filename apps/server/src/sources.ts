// The operators, feeds and rail_networks tables follow config/operators/*/operator.json,
// config/feeds/*/feed.json and config/networks/*/network.json
// (docs/DESIGN.md#feeds-operators-and-rail-networks): rows of a feed or network reference it, and a
// feed its operator, so anything that writes them (the server, the import, statistics and features
// tools) syncs these first.

import type { Db } from "@transitopia/db/connect.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import {
  readFeeds,
  readNetworks,
  readOperators,
} from "@transitopia/data/paths.ts";

export async function syncSources(db: Db, feeds?: FeedInfo[]): Promise<void> {
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
  for (const n of await readNetworks()) {
    const row = { name: n.name, timezone: n.timezone };
    await db
      .insertInto("rail_networks")
      .values({ id: n.id, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row))
      .execute();
  }
}
