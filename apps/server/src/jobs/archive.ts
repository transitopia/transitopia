// Copies closed recordings to object storage (V2-PLAN.md §4.4: hourly NDJSON.gz files for dev
// snapshots and replay) and expires raw data after the retention period, locally, in the database
// and in the archive. Service changes, alerts and dispatch versions are kept.

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AIS_HISTORY_DIR,
  DISPATCH_HISTORY_DIR,
  RT_HISTORY_DIR,
} from "@transitopia/pipelines/lib/paths.ts";
import type { Db } from "@transitopia/db/connect.ts";
import { dropExpiredPartitions } from "@transitopia/db/partitions.ts";
import { toWallTime } from "@transitopia/transit-core/time.ts";
import { run } from "./exec.ts";

/** Upload closed hour files (and the kept records) to `remote`. The open hour is left for later. */
export async function archiveRecordings(remote: string): Promise<void> {
  const copy = async (dir: string, dest: string, filters: string[]) => {
    // Nothing recorded there (yet), e.g. no AIS key.
    if (!existsSync(dir)) return;
    await run("rclone", [
      "copy",
      dir,
      `${remote}/${dest}`,
      ...filters,
      "--s3-no-check-bucket",
    ]);
  };
  const include = (...globs: string[]) =>
    globs.flatMap((g) => ["--include", g]);
  await copy(
    RT_HISTORY_DIR,
    "rt-history",
    include("*.ndjson.gz", "changes/*.json", "alerts.ndjson", "coverage.json"),
  );
  await copy(
    AIS_HISTORY_DIR,
    "ais-history",
    include("*.ndjson.gz", "coverage.json"),
  );
  await copy(DISPATCH_HISTORY_DIR, "dispatch-history", []);
}

const localDay = (t: number) => {
  const w = toWallTime(t);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
};

/** Delete raw data older than `retentionDays`. Returns what was removed, for the job log. */
export async function expireRawData(opts: {
  db: Db | undefined;
  retentionDays: number;
  archiveRemote: string | undefined;
  now?: number;
}): Promise<{ partitions: string[]; dirs: string[] }> {
  const cutoff = (opts.now ?? Date.now()) - opts.retentionDays * 86_400_000;
  const partitions =
    opts.db ? await dropExpiredPartitions(opts.db, cutoff) : [];
  if (opts.db)
    await opts.db
      .deleteFrom("upstream_requests")
      .where("ts", "<", new Date(cutoff))
      .execute();
  const dirs: string[] = [];
  const oldest = localDay(cutoff);
  for (const base of [RT_HISTORY_DIR, AIS_HISTORY_DIR]) {
    let days: string[] = [];
    try {
      days = await readdir(base);
    } catch {
      continue;
    }
    for (const d of days)
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < oldest) {
        await rm(join(base, d), { recursive: true, force: true });
        dirs.push(join(base, d));
      }
  }
  if (opts.archiveRemote)
    for (const sub of ["rt-history", "ais-history"])
      await run(
        "rclone",
        [
          "delete",
          `${opts.archiveRemote}/${sub}`,
          "--min-age",
          `${opts.retentionDays}d`,
          "--include",
          "????-??-??/*.ndjson.gz",
        ],
        // 3: directory not found, i.e. nothing archived there yet.
        { okCodes: [0, 3] },
      );
  return { partitions, dirs };
}
