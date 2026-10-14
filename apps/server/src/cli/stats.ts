// Compute (or recompute) observed stop times and route statistics for service dates, e.g. after
// changing their definitions (bump STATS_VERSION in packages/transit-core/src/rt/stats.ts). The
// server does this nightly on its own; raw positions older than the retention period are gone.
//
//   DATABASE_URL=postgres://… npm run stats -- 20260928 [20260929 …] [--feed translink]
//
// Every feed with real-time data, or the one named.

import { readFeed, readFeeds } from "@transitopia/data/paths.ts";
import { createDb } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { dailyStats, type RealtimeFeed } from "../jobs/daily.ts";

const url = process.env.DATABASE_URL;
const args = process.argv.slice(2);
const dates = args.filter((a) => /^\d{8}$/.test(a));
const only =
  args.includes("--feed") ? args[args.indexOf("--feed") + 1] : undefined;
if (!url || !dates.length) {
  console.error(
    "Usage: DATABASE_URL=postgres://… npm run stats -- YYYYMMDD [YYYYMMDD …] [--feed <id>]",
  );
  process.exit(1);
}
const feeds = (only ? [await readFeed(only)] : await readFeeds()).filter(
  (f): f is typeof f & RealtimeFeed => Boolean(f.realtime),
);
const { db, pool } = createDb(url);
await migrate(pool);
for (const feed of feeds)
  for (const date of dates) {
    const t0 = Date.now();
    const r = await dailyStats(db, feed, date, (m) => console.log(m));
    console.log(
      `${feed.id} ${date}: ${JSON.stringify(r)} in ${Math.round((Date.now() - t0) / 1000)} s`,
    );
  }
await db.destroy();
