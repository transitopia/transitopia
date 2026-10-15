// Download each feed's latest GTFS static zip (config/feeds/<feed>/feed.json → static.url), or a dated
// snapshot where the provider keeps them, and archive it by feed_version under
// var/raw/gtfs/<feed>/<version dir>/google_transit.zip. Idempotent: an already-archived version is
// left alone, and so is a download whose files are the same as the newest archived version's (BC
// Transit publishes the same timetable under a new feed_version every day). See
// packages/transit-core/DESIGN.md#timetables.
//
//   tsx pipelines/fetch-gtfs.ts                              # every region's feeds, latest
//   tsx pipelines/fetch-gtfs.ts --feed translink             # one feed
//   tsx pipelines/fetch-gtfs.ts --feed translink --history 2026-09-25

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { readCsvAll, zipSignature } from "@transitopia/data/gtfs-zip.ts";
import { archivedFeeds } from "@transitopia/data/gtfs-day.ts";
import { migrateLegacyFiles } from "@transitopia/data/legacy.ts";
import {
  exists,
  feedPaths,
  log,
  readFeed,
  readFeeds,
} from "@transitopia/data/paths.ts";
import type { FeedInfo } from "@transitopia/transit-core/config.ts";
import { versionDir } from "@transitopia/transit-core/plan/types.ts";

export interface FetchedFeed {
  feed: string;
  version: string;
  start: string;
  end: string;
  path: string;
  isNew: boolean;
}

export async function fetchGtfs(
  feed: FeedInfo,
  url = feed.static.url,
): Promise<FetchedFeed> {
  const raw = feedPaths(feed.id).raw;
  await mkdir(raw, { recursive: true });
  const tmp = join(raw, `download-${process.pid}.zip`);
  log(`${feed.id}: downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Transitopia (+https://www.transitopia.org)" },
  });
  if (!res.ok || !res.body)
    throw new Error(`${feed.id}: GTFS download failed: HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream),
    createWriteStream(tmp),
  );

  try {
    const [info] = await readCsvAll(tmp, "feed_info.txt");
    if (!info?.feed_version || !info.feed_start_date || !info.feed_end_date)
      throw new Error(
        `${feed.id}: downloaded feed has no feed_info.txt feed_version and dates`,
      );
    const version = info.feed_version;
    const found = {
      feed: feed.id,
      version,
      start: info.feed_start_date,
      end: info.feed_end_date,
    };
    const dest = join(raw, versionDir(version), "google_transit.zip");
    if (await exists(dest)) {
      log(`${feed.id}: feed ${version} already archived`);
      return { ...found, path: dest, isNew: false };
    }
    // The same files as the newest archived version (only feed_info.txt differs): keep that one.
    const newest = (await archivedFeeds(feed.id))[0];
    if (
      newest
      && newest.end >= found.end
      && (await zipSignature(newest.path)) === (await zipSignature(tmp))
    ) {
      log(
        `${feed.id}: feed ${version} has the same timetable as ${newest.version}; not archived`,
      );
      return {
        feed: feed.id,
        version: newest.version,
        start: newest.start,
        end: newest.end,
        path: newest.path,
        isNew: false,
      };
    }
    await mkdir(join(raw, versionDir(version)), { recursive: true });
    await rename(tmp, dest);
    log(
      `${feed.id}: archived new feed ${version} (${found.start} → ${found.end})`,
    );
    return { ...found, path: dest, isNew: true };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function main() {
  const moved = await migrateLegacyFiles();
  if (moved.length)
    log(`Moved into TransLink's directories: ${moved.join(", ")}`);
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const only = arg("--feed");
  const history = arg("--history");
  const feeds = only ? [await readFeed(only)] : await readFeeds();
  if (history) {
    const [feed] = feeds;
    if (!only || !feed?.static.historyUrl)
      throw new Error(
        "--history needs --feed <id>, for a feed with static.historyUrl",
      );
    await fetchGtfs(feed, feed.static.historyUrl.replace("{date}", history));
    return;
  }
  // One feed failing (a provider down) doesn't stop the others; the build uses what's archived.
  let failed = 0;
  for (const feed of feeds)
    await fetchGtfs(feed).catch((e: unknown) => {
      failed++;
      log(`✖ ${e instanceof Error ? e.message : String(e)}`);
    });
  if (failed === feeds.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
