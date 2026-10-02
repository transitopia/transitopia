// Compute (or recompute) observed stop times and route statistics for service dates, e.g. after
// changing their definitions (bump STATS_VERSION in packages/transit-core/src/rt/stats.ts). The
// server does this nightly on its own; raw positions older than the retention period are gone.
//
//   DATABASE_URL=postgres://… npm run stats -- 20260928 [20260929 …]

import region from "@transitopia/region-metro-vancouver/region.json" with { type: "json" };
import { createDb } from "@transitopia/db/connect.ts";
import { migrate } from "@transitopia/db/migrate.ts";
import { dailyStats } from "../jobs/daily.ts";

const url = process.env.DATABASE_URL;
const dates = process.argv.slice(2).filter((a) => /^\d{8}$/.test(a));
if (!url || !dates.length) {
  console.error(
    "Usage: DATABASE_URL=postgres://… npm run stats -- YYYYMMDD [YYYYMMDD …]",
  );
  process.exit(1);
}
const { db, pool } = createDb(url);
await migrate(pool);
for (const date of dates) {
  const t0 = Date.now();
  const r = await dailyStats(db, region.id, date, (m) => console.log(m));
  console.log(
    `${date}: ${JSON.stringify(r)} in ${Math.round((Date.now() - t0) / 1000)} s`,
  );
}
await db.destroy();
