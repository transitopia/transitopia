// The daily transit data build on the server (apps/server/README.md#jobs). It detects new GTFS feeds and
// publishes to object storage. It runs the same steps as `npm run data`, with
// the confirmed corrections exported from the database, then archives new GTFS feeds, reconciles
// them into the feature registry (docs/DESIGN.md#feature-ids) and publishes
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
import { isoDate } from "../dates.ts";
import { reconcileConfig } from "../config.ts";
import { reconcileFeeds } from "../features/reconcile.ts";
import { registryFromDb } from "../features/export.ts";
import { writeExport, writeFeedPlaces } from "@transitopia/data/features.ts";
import { localDate } from "@transitopia/transit-core/time.ts";

export interface DataBuildResult {
  newFeeds: string[];
  /** Feed versions reconciled into the feature registry ("<feed>/<version>"). */
  reconciled: string[];
  /** Why reconciliation failed, if it did: it never stops the build from publishing. */
  reconcileError?: string;
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
  // The server writes the places files itself, after reconciling.
  const childEnv: NodeJS.ProcessEnv = { TRANSITOPIA_SKIP_PLACES: "1" };
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
      newFeeds.push(...(await recordFeeds(db, f.id, env.archiveRemote, log)));
  // Feature IDs for the new versions (and any not yet reconciled), apps/server/README.md#feature-reconciliation.
  const reconciled: string[] = [];
  let reconcileError: string | undefined;
  if (db)
    try {
      for (const r of await reconcileFeeds({
        db,
        feeds: opts.feeds,
        settings: reconcileConfig,
        archiveRemote: env.archiveRemote,
        log,
      }))
        reconciled.push(`${r.feed}/${r.version}`);
    } catch (e) {
      reconcileError = (e as Error).message;
      log(`feature reconciliation failed: ${reconcileError}`);
    }
  // Places files and the public export, from the registry (docs/DESIGN.md#published-features).
  if (db)
    try {
      await writeFeatureData(db, opts.feeds, log);
    } catch (e) {
      log(`writing places files failed: ${(e as Error).message}`);
    }
  let published = false;
  if (env.dataPublishRemote) {
    await publishData(env.dataPublishRemote);
    published = true;
    log(`published transit data to ${env.dataPublishRemote}`);
  }
  return {
    newFeeds,
    reconciled,
    ...(reconcileError ? { reconcileError } : {}),
    published,
  };
}

/** Files clients poll to find the current version of the rest: published last, with a short cache. */
const POINTERS = ["manifest.json", "places.json", "latest.json"];

/**
 * Publish var/public/data (or only the files `include` names, as rclone filters) to `remote`.
 * Everything but the pointers first, so no client reads a manifest or index pointing at files that
 * aren't there yet; old files stay for clients holding an older pointer (copy, not sync). The
 * filters name a file anywhere: every feed's data/feeds/<feed>/manifest.json.
 */
export async function publishData(
  remote: string,
  include?: string[],
): Promise<void> {
  const dest = `${remote}/data`;
  const filters = (names: string[], flag: string) =>
    names.flatMap((n) => [flag, n]);
  await run("rclone", [
    "copy",
    PUBLIC_DATA_DIR,
    dest,
    ...filters(POINTERS, "--exclude"),
    ...(include ? filters(include, "--include") : []),
    "--header-upload",
    "Cache-Control: public, max-age=86400",
    "--s3-no-check-bucket",
  ]);
  await run("rclone", [
    "copy",
    PUBLIC_DATA_DIR,
    dest,
    ...filters(
      include ? POINTERS.filter((p) => p !== "manifest.json") : POINTERS,
      "--include",
    ),
    "--header-upload",
    "Cache-Control: public, max-age=300",
    "--s3-no-check-bucket",
  ]);
}

/** Write every feed's places files (those that changed) and the day's public export from the registry. */
export async function writeFeatureData(
  db: Db,
  feeds: Pick<FeedInfo, "id">[],
  log: (msg: string) => void,
  opts: { export?: boolean } = {},
): Promise<string[]> {
  const registry = await registryFromDb(db);
  const written = await writeFeedPlaces(
    registry,
    feeds.map((f) => f.id),
    log,
  );
  if (opts.export ?? true) await writeExport(registry, localDate(Date.now()));
  return written;
}

/**
 * Add a feed's archived GTFS versions to gtfs_feeds (kept indefinitely), uploading the zips to the
 * archive when there is one.
 */
export async function recordFeeds(
  db: Db,
  feedId: string,
  archiveRemote: string | undefined,
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
  // In the order they were fetched (fetched_at): gtfs_feeds.seq numbers versions as they're recorded.
  const zips = await Promise.all(
    (await archivedFeeds(feedId)).map(async (f) => ({
      ...f,
      fetchedAt: (await stat(f.path)).mtime,
    })),
  );
  zips.sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
  for (const f of zips) {
    if (known.has(f.version)) continue;
    // TransLink's zips were archived at gtfs/metro-vancouver/<version>/ before feeds had ids.
    const key = `gtfs/${feedId}/${f.version}/google_transit.zip`;
    if (archiveRemote)
      await run("rclone", [
        "copyto",
        f.path,
        `${archiveRemote}/${key}`,
        "--s3-no-check-bucket",
      ]);
    const row = {
      feed_id: feedId,
      version: f.version,
      start_date: isoDate(f.start),
      end_date: isoDate(f.end),
      fetched_at: f.fetchedAt,
      sha256: await sha256File(f.path),
      bytes: (await stat(f.path)).size,
      object_key: archiveRemote ? key : null,
    };
    await db
      .insertInto("gtfs_feeds")
      .values(row)
      .onConflict((oc) => oc.columns(["feed_id", "version"]).doUpdateSet(row))
      .execute();
    added.push(`${feedId}/${f.version}`);
    log(
      `GTFS feed ${feedId} ${f.version} recorded${archiveRemote ? " and archived" : ""}`,
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
