// Pull production data into a local checkout (V2-PLAN.md §7.5): recorded hours for a date range
// and, optionally, the nightly database snapshot (everything but users, sessions and raw rows; see
// infra/backup/backup.sh), restored into the dev database (infra/compose.dev.yml).
//
//   npm run snapshot:pull -- --from 2026-09-20 --to 2026-09-27 [--db] [--remote r2:transitopia-archive]
//
// Needs rclone with read access to the archive (TRANSITOPIA_ARCHIVE or --remote). Raw recordings
// exist for the last 60 days only. Everything is private for now: whether TransLink's and
// aisstream.io's data may be republished is still being checked (V2-PLAN.md §10.3), so there are
// no public snapshots yet.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import seabus from "@transitopia/region-metro-vancouver/config/seabus.json" with { type: "json" };
import {
  cadence,
  type CadenceConfig,
} from "@transitopia/transit-core/rt/budget.ts";
import { extendCoverage } from "@transitopia/transit-core/rt/types.ts";
import { join } from "node:path";
import {
  AIS_HISTORY_DIR,
  DISPATCH_HISTORY_DIR,
  RT_HISTORY_DIR,
  ROOT,
  VAR_DIR,
  log,
  writeJson,
} from "./lib/paths.ts";

const CADENCE = cadence(rtConfig as unknown as CadenceConfig);

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
  let t = Date.parse(`${from}T12:00:00Z`);
  t <= Date.parse(`${to}T12:00:00Z`);
  t += 86_400_000
)
  dates.push(new Date(t).toISOString().slice(0, 10));

for (const d of dates) {
  const compact = d.replaceAll("-", "");
  log(`${d}: recordings, service changes, dispatch versions`);
  rclone("copy", `${remote}/rt-history/${d}`, join(RT_HISTORY_DIR, d));
  rclone("copy", `${remote}/ais-history/${d}`, join(AIS_HISTORY_DIR, d));
  rclone(
    "copy",
    `${remote}/rt-history/changes`,
    join(RT_HISTORY_DIR, "changes"),
    "--include",
    `${compact}.json`,
  );
  rclone(
    "copy",
    `${remote}/dispatch-history/${compact}`,
    join(DISPATCH_HISTORY_DIR, compact),
  );
}
// The recorder's coverage index (what a local server reports at /rt/coverage), from the hours now here.
for (const [dir, gapMs] of [
  [RT_HISTORY_DIR, (t: number) => CADENCE.coverageGapMs(t)],
  [AIS_HISTORY_DIR, () => seabus.ais.coverageGapS * 1000],
] as const) {
  const intervals: [number, number][] = [];
  if (existsSync(dir))
    for (const day of (await readdir(dir))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort())
      for (const f of (await readdir(join(dir, day))).sort()) {
        const m = /^\d{2}\.ndjson(\.gz)?$/.exec(f);
        if (!m) continue;
        const buf = await readFile(join(dir, day, f));
        for (const line of (m[1] ? gunzipSync(buf) : buf)
          .toString("utf8")
          .split("\n")) {
          const t = /^\{"t":(\d+)/.exec(line)?.[1];
          if (t) extendCoverage(intervals, Number(t), gapMs(Number(t)));
        }
      }
  if (intervals.length)
    await writeJson(join(dir, "coverage.json"), { intervals });
}

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
