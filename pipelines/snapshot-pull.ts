// Pull production data into a local checkout (deployment/README.md#snapshots-for-development): recorded hours for a date range
// and, optionally, the nightly database snapshot (everything but users, sessions and raw rows; see
// infra/backup/backup.sh), restored into the dev database (infra/compose.dev.yml).
//
//   npm run snapshot:pull -- --from 2026-09-20 --to 2026-09-27 [--db] [--remote r2:transitopia-archive]
//
// Needs rclone with read access to the archive (TRANSITOPIA_ARCHIVE or --remote). Raw recordings
// exist for the last 60 days only. Everything is private for now: whether TransLink's data may be
// republished is still being checked (DATA-LICENSES.md; aisstream.io's may be), so there are no
// public snapshots yet.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { cadence } from "@transitopia/transit-core/rt/budget.ts";
import { Recorder } from "@transitopia/server/rt/recorder.ts";
import { join } from "node:path";
import {
  DISPATCH_HISTORY_DIR,
  ROOT,
  VAR_DIR,
  feedPaths,
  log,
  readFeeds,
} from "@transitopia/data/paths.ts";

const allFeeds = await readFeeds();
const feeds = allFeeds.filter((f) => f.realtime);
const aisFeeds = allFeeds.filter((f) => f.ais);

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const remote = opt("--remote") ?? process.env.TRANSITOPIA_ARCHIVE;
const from = opt("--from");
const to = opt("--to") ?? from;
if (
  !remote
  || !from
  || !/^\d{4}-\d{2}-\d{2}$/.test(from)
  || !/^\d{4}-\d{2}-\d{2}$/.test(to!)
) {
  console.error(
    "Usage: npm run snapshot:pull -- --from YYYY-MM-DD [--to YYYY-MM-DD] [--db] [--remote <rclone remote:bucket>]\n"
      + "(or set TRANSITOPIA_ARCHIVE)",
  );
  process.exit(1);
}

function rclone(...a: string[]): void {
  const r = spawnSync("rclone", a, { stdio: "inherit" });
  // 3: directory not found (nothing recorded there that day).
  if (r.status !== 0 && r.status !== 3)
    throw new Error(`rclone ${a[0]} failed (exit ${r.status})`);
}

const dates: string[] = [];
for (
  let d = Temporal.PlainDate.from(from);
  Temporal.PlainDate.compare(d, Temporal.PlainDate.from(to!)) <= 0;
  d = d.add({ days: 1 })
)
  dates.push(d.toString());

for (const d of dates) {
  const compact = d.replaceAll("-", "");
  log(`${d}: recordings, service changes, dispatch versions`);
  for (const feed of feeds) {
    const local = feedPaths(feed.id).rtHistory;
    const archived = `rt-history/${feed.id}`;
    rclone("copy", `${remote}/${archived}/${d}`, join(local, d));
    rclone(
      "copy",
      `${remote}/${archived}/changes`,
      join(local, "changes"),
      "--include",
      `${compact}.json`,
    );
  }
  for (const feed of aisFeeds) {
    const local = feedPaths(feed.id).aisHistory;
    rclone("copy", `${remote}/ais-history/${feed.id}/${d}`, join(local, d));
  }
  rclone(
    "copy",
    `${remote}/dispatch-history/${compact}`,
    join(DISPATCH_HISTORY_DIR, compact),
  );
}
// The recorder's coverage index (what a local server reports at /rt/coverage), from the hours now here.
for (const recorder of [
  ...feeds.map((f) => {
    const c = cadence(f.realtime!);
    return new Recorder(
      feedPaths(f.id).rtHistory,
      (t: number) => c.coverageGapMs(t),
      { emptyIsGap: true },
    );
  }),
  ...aisFeeds.map(
    (f) => new Recorder(feedPaths(f.id).aisHistory, f.ais!.coverageGapS * 1000),
  ),
])
  if (existsSync(recorder.dir)) await recorder.rebuildCoverage();

if (args.includes("--db")) {
  const tmp = join(VAR_DIR, "snapshot");
  await mkdir(tmp, { recursive: true });
  rclone("copy", `${remote}/backups/snapshots/db-latest.dump`, tmp);
  log(
    "Restoring the database snapshot into the dev database (infra/compose.dev.yml)",
  );
  const r = spawnSync(
    "sh",
    [
      "-c",
      `docker compose -f infra/compose.dev.yml exec -T db pg_restore --clean --if-exists --no-owner -U transitopia -d transitopia < "${join(tmp, "db-latest.dump")}"`,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  await rm(tmp, { recursive: true, force: true });
  // pg_restore exits 1 on warnings (e.g. objects that didn't exist to drop).
  if ((r.status ?? 1) > 1)
    throw new Error(`pg_restore failed (exit ${r.status})`);
  log(
    "Done. Import the pulled hours into it too with: DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/transitopia npm run db:import-history",
  );
}
