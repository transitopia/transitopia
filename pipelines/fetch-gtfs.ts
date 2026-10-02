// Download the latest TransLink GTFS static feed (or a dated History snapshot) and archive it by
// feed_version under var/raw/gtfs/<feed_version>/google_transit.zip. Idempotent: an already-archived
// version is left alone. See packages/transit-core/DESIGN.md#timetables.
//
//   tsx pipelines/fetch-gtfs.ts                 # latest feed
//   tsx pipelines/fetch-gtfs.ts --history 2026-09-25

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { readCsvAll } from "./lib/gtfs-zip.ts";
import { GTFS_RAW_DIR, log } from "./lib/paths.ts";

const LATEST_URL = "https://gtfs-static.translink.ca/gtfs/google_transit.zip";
const HISTORY_URL = (date: string) =>
  `https://gtfs-static.translink.ca/gtfs/History/${date}/google_transit.zip`;

export interface FetchedFeed {
  version: string;
  start: string;
  end: string;
  path: string;
  isNew: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function fetchGtfs(url = LATEST_URL): Promise<FetchedFeed> {
  await mkdir(GTFS_RAW_DIR, { recursive: true });
  const tmp = join(GTFS_RAW_DIR, `download-${process.pid}.zip`);
  log(`Downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Transitopia (+https://www.transitopia.org)" },
  });
  if (!res.ok || !res.body)
    throw new Error(`GTFS download failed: HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream),
    createWriteStream(tmp),
  );

  const [info] = await readCsvAll(tmp, "feed_info.txt");
  if (!info?.feed_version) {
    await rm(tmp, { force: true });
    throw new Error("Downloaded feed has no feed_info.txt feed_version");
  }
  const version = info.feed_version;
  const dir = join(GTFS_RAW_DIR, version);
  const dest = join(dir, "google_transit.zip");
  const isNew = !(await exists(dest));
  if (isNew) {
    await mkdir(dir, { recursive: true });
    await rename(tmp, dest);
    log(
      `Archived new feed ${version} (${info.feed_start_date} → ${info.feed_end_date})`,
    );
  } else {
    await rm(tmp, { force: true });
    log(`Feed ${version} already archived`);
  }
  return {
    version,
    start: info.feed_start_date!,
    end: info.feed_end_date!,
    path: dest,
    isNew,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--history");
  const url = i >= 0 ? HISTORY_URL(process.argv[i + 1] ?? "") : LATEST_URL;
  fetchGtfs(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
