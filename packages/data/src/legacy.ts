// Files from before feeds had ids (docs/DESIGN.md#regions-and-feeds), all TransLink's, moved once
// into TransLink's directories: archived GTFS zips (var/raw/gtfs/<version>/) and real-time
// recordings (var/rt-history/<date>/, changes/, alerts.ndjson, coverage.json, requests.json). The
// leader's lock file stays where it is. Idempotent and cheap, so everything that reads these calls it.

import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { GTFS_RAW_DIR, RT_HISTORY_DIR, feedPaths } from "./paths.ts";
import { LEGACY_FEED } from "@transitopia/transit-core/plan/types.ts";

const RT_FILES = new Set([
  "changes",
  "alerts.ndjson",
  "coverage.json",
  "requests.json",
]);

async function moveInto(
  base: string,
  dest: string,
  which: (name: string) => boolean,
): Promise<string[]> {
  if (!existsSync(base)) return [];
  const moved: string[] = [];
  for (const name of await readdir(base)) {
    if (!which(name)) continue;
    await mkdir(dest, { recursive: true });
    if (existsSync(join(dest, name)))
      throw new Error(
        `Can't move ${join(base, name)}: ${join(dest, name)} exists`,
      );
    await rename(join(base, name), join(dest, name));
    moved.push(name);
  }
  return moved;
}

/** Move pre-feed files into TransLink's directories. Returns what moved, for a log line. */
export async function migrateLegacyFiles(): Promise<string[]> {
  const gtfs = await moveInto(GTFS_RAW_DIR, feedPaths(LEGACY_FEED).raw, (n) =>
    existsSync(join(GTFS_RAW_DIR, n, "google_transit.zip")),
  );
  const rt = await moveInto(
    RT_HISTORY_DIR,
    feedPaths(LEGACY_FEED).rtHistory,
    (n) => /^\d{4}-\d{2}-\d{2}$/.test(n) || RT_FILES.has(n),
  );
  return [
    ...gtfs.map((v) => `var/raw/gtfs/${v}`),
    ...rt.map((n) => `var/rt-history/${n}`),
  ];
}
