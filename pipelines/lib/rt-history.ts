// Read a feed's recorded GTFS-RT snapshots (var/rt-history/<feed>/<date>/<HH>.ndjson[.gz], written
// by the RT recorder) and the prepared plans they belong to.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeSnapshot,
  trackedOnly,
  type RtSnapshot,
} from "@transitopia/transit-core/rt/types.ts";
import { feedForDate } from "@transitopia/transit-core/plan/types.ts";
import {
  preparePlan,
  type PreparedPlan,
} from "@transitopia/transit-core/schedule/engine.ts";
import { localDate } from "@transitopia/transit-core/time.ts";
import { readPlan } from "@transitopia/data/plans.ts";
import {
  PUBLIC_DIR,
  feedPaths,
  readManifest,
  regionOfFeed,
  readFeedConfig,
} from "@transitopia/data/paths.ts";

export interface RecordedHour {
  /** "<date>T<HH>" as recorded, e.g. "2026-09-26T17". */
  label: string;
  /** Still being written by the recorder. */
  open: boolean;
  snapshots: RtSnapshot[];
}

export async function loadRecordedHours(feed: string): Promise<RecordedHour[]> {
  const out: RecordedHour[] = [];
  for await (const h of eachRecordedHour(feed)) out.push(h);
  return out;
}

/**
 * Recorded hours one at a time, oldest first, optionally only local dates from `sinceDate`
 * (YYYY-MM-DD) on: the history holds every route for weeks, too much to hold at once.
 */
export async function* eachRecordedHour(
  feed: string,
  sinceDate = "",
): AsyncGenerator<RecordedHour> {
  const dir = feedPaths(feed).rtHistory;
  if (!existsSync(dir)) return;
  for (const day of (await readdir(dir))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= sinceDate)
    .sort()) {
    for (const f of (await readdir(join(dir, day))).sort()) {
      const m = /^(\d{2})\.ndjson(\.gz)?$/.exec(f);
      if (!m) continue;
      const buf = await readFile(join(dir, day, f));
      const text = (m[2] ? gunzipSync(buf) : buf).toString("utf8");
      const snapshots: RtSnapshot[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          snapshots.push(trackedOnly(decodeSnapshot(line)));
        } catch {
          // Partial last line of an open file.
        }
      }
      yield { label: `${day}T${m[1]}`, open: !m[2], snapshots };
    }
  }
}

/** A feed's prepared plans by version, loaded on demand; `forTime` picks the version for an instant. */
export async function planLoader(feed: string) {
  const manifest = await readManifest(feed);
  const kin = (await readFeedConfig(feed, (await regionOfFeed(feed)).id))
    .kinematics;
  const cache = new Map<string, PreparedPlan>();
  return {
    kin,
    async forTime(ms: number): Promise<PreparedPlan | undefined> {
      const feed = feedForDate(manifest, localDate(ms));
      if (!feed) return undefined;
      let pp = cache.get(feed.version);
      if (!pp)
        cache.set(
          feed.version,
          (pp = preparePlan(await readPlan(join(PUBLIC_DIR, feed.path)), kin)),
        );
      return pp;
    },
  };
}
