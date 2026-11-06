// GTFS route_id → the route drawn for it, from every archived version of a feed
// (var/raw/gtfs/<feed>/). Route ids can change between versions, and recordings keep the ids of the
// version they were recorded under. Versions a newer one shadows have no plan
// (pipelines/build-schedule.ts), so this reads each zip's routes.txt with today's routes.json: the
// routes drawn now.

import { readCsvAll } from "./gtfs-zip.ts";
import { archivedFeeds } from "./gtfs-day.ts";
import { log, readFeed, readFeedRoutes } from "./paths.ts";
import { selectRoutes } from "@transitopia/transit-core/plan/routes.ts";
import {
  gtfsRouteIds,
  type PlanRoute,
} from "@transitopia/transit-core/plan/types.ts";

export async function routesByGtfsId(
  feed: string,
): Promise<Map<string, PlanRoute>> {
  const info = await readFeed(feed);
  const cfg = await readFeedRoutes(feed);
  const out = new Map<string, PlanRoute>();
  // Oldest first, so the newest version's routes win.
  for (const z of (await archivedFeeds(feed)).reverse()) {
    let routes: PlanRoute[];
    try {
      routes = selectRoutes(
        await readCsvAll(z.path, "routes.txt"),
        cfg,
        feed,
        info.dataset,
        info.routeKey,
      ).routes;
    } catch (e) {
      // An old version today's routes.json no longer fits (two of its routes get one key), or a zip
      // that can't be read: its ids are left out rather than the feed's.
      log(
        `${feed} ${z.version}: route ids left out (${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    for (const r of routes) for (const id of gtfsRouteIds(r)) out.set(id, r);
  }
  return out;
}
