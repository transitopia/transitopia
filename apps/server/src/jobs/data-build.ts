// The daily transit data build on the server (apps/server/README.md#jobs). It detects new GTFS feeds and
// publishes to object storage. It runs the same steps as `npm run data`, with
// the confirmed corrections exported from the database, then archives new GTFS feeds and publishes
// var/public/data for data.transitopia.org. Building here keeps the live dispatcher's base plans
// identical to what browsers load: a dispatch patch only fits the build it was made from.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CORRECTIONS_EXPORT_DIR,
  PUBLIC_DATA_DIR,
  ROOT,
} from "@transitopia/data/paths.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import { archivedFeeds } from "@transitopia/data/gtfs-day.ts";
import type { Db } from "@transitopia/db/connect.ts";
import type { CorrectionsRepo } from "../corrections.ts";
import type { ServerEnv } from "../env.ts";
import { run } from "./exec.ts";
import { isoDate } from "../store.ts";

export interface DataBuildResult {
  newFeeds: string[];
  published: boolean;
}

export async function buildData(opts: {
  db: Db | undefined;
  feeds: FeedInfo[];
  repo: CorrectionsRepo | undefined;
  env: ServerEnv;
  log: (msg: string) => void;
}): Promise<DataBuildResult> {
  const { db, repo, env, log } = opts;
  const childEnv: NodeJS.ProcessEnv = {};
  if (repo) {
    // The pipelines read a region's corrections from <dir>/<region>/ (regionPaths).
    const n = await repo.exportFiles(
      join(CORRECTIONS_EXPORT_DIR, repo.regionId),
    );
    log(
      `exported ${n.observationSets} observation sets and ${n.disruptions} disruptions for the build`,
    );
    childEnv.TRANSITOPIA_CORRECTIONS_DIR = CORRECTIONS_EXPORT_DIR;
  }
  await run(process.execPath, ["--import", "tsx", "pipelines/data.ts"], {
    cwd: ROOT,
    env: childEnv,
    log: (l) => log(`data: ${l}`),
  });
  const newFeeds: string[] = [];
  if (db)
    for (const f of opts.feeds)
      newFeeds.push(...(await recordFeeds(db, f.id, env, log)));
  let published = false;
  if (env.dataPublishRemote) {
    const dest = `${env.dataPublishRemote}/data`;
    // Everything but the manifests first, so no client reads a manifest pointing at files that
    // aren't there yet; old files stay for clients holding an older manifest (copy, not sync). The
    // filter names a file anywhere: every feed's data/feeds/<feed>/manifest.json.
    await run("rclone", [
      "copy",
      PUBLIC_DATA_DIR,
      dest,
      "--exclude",
      "manifest.json",
      "--header-upload",
      "Cache-Control: public, max-age=86400",
      "--s3-no-check-bucket",
    ]);
    await run("rclone", [
      "copy",
      PUBLIC_DATA_DIR,
      dest,
      "--include",
      "manifest.json",
      "--header-upload",
      "Cache-Control: public, max-age=300",
      "--s3-no-check-bucket",
    ]);
    published = true;
    log(`published transit data to ${env.dataPublishRemote}`);
  }
  return { newFeeds, published };
}

/** Add a feed's archived GTFS versions to gtfs_feeds (kept indefinitely), uploading the zips to the archive. */
async function recordFeeds(
  db: Db,
  feedId: string,
  env: ServerEnv,
  log: (msg: string) => void,
): Promise<string[]> {
  const known = new Set(
    (
      await db
        .selectFrom("gtfs_feeds")
        .select("version")
        .where("feed_id", "=", feedId)
        .where("object_key", "is not", null)
        .execute()
    ).map((r) => r.version),
  );
  const added: string[] = [];
  for (const f of await archivedFeeds(feedId)) {
    if (known.has(f.version)) continue;
    // TransLink's zips were archived at gtfs/metro-vancouver/<version>/ before feeds had ids.
    const key = `gtfs/${feedId}/${f.version}/google_transit.zip`;
    if (env.archiveRemote)
      await run("rclone", [
        "copyto",
        f.path,
        `${env.archiveRemote}/${key}`,
        "--s3-no-check-bucket",
      ]);
    const row = {
      feed_id: feedId,
      version: f.version,
      start_date: isoDate(f.start),
      end_date: isoDate(f.end),
      fetched_at: (await stat(f.path)).mtime,
      sha256: await sha256File(f.path),
      bytes: (await stat(f.path)).size,
      object_key: env.archiveRemote ? key : null,
    };
    await db
      .insertInto("gtfs_feeds")
      .values(row)
      .onConflict((oc) => oc.columns(["feed_id", "version"]).doUpdateSet(row))
      .execute();
    added.push(`${feedId}/${f.version}`);
    log(
      `GTFS feed ${feedId} ${f.version} recorded${env.archiveRemote ? " and archived" : ""}`,
    );
  }
  return added;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => h.update(b))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
