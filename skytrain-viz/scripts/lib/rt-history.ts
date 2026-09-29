// Read recorded GTFS-RT snapshots (data/rt-history/<date>/<HH>.ndjson[.gz], written by the RT
// recorder) and the prepared plans they belong to.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeSnapshot, type RtSnapshot } from '../../src/core/rt/types.ts';
import { feedForDate, type FeedManifest, type ServicePlan } from '../../src/core/plan/types.ts';
import { preparePlan, type PreparedPlan } from '../../src/core/schedule/engine.ts';
import type { KinematicsConfig } from '../../src/core/movement/kinematics.ts';
import { localDate } from '../../src/core/time.ts';
import { CONFIG_DIR, FEEDS_OUT_DIR, PUBLIC_DATA_DIR, ROOT, readJson } from './paths.ts';

export const RT_HISTORY_DIR = join(ROOT, 'data', 'rt-history');

export interface RecordedHour {
  /** "<date>T<HH>" as recorded, e.g. "2026-09-26T17". */
  label: string;
  /** Still being written by the recorder. */
  open: boolean;
  snapshots: RtSnapshot[];
}

export async function loadRecordedHours(): Promise<RecordedHour[]> {
  const out: RecordedHour[] = [];
  if (!existsSync(RT_HISTORY_DIR)) return out;
  for (const day of (await readdir(RT_HISTORY_DIR)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    for (const f of (await readdir(join(RT_HISTORY_DIR, day))).sort()) {
      const m = /^(\d{2})\.ndjson(\.gz)?$/.exec(f);
      if (!m) continue;
      const buf = await readFile(join(RT_HISTORY_DIR, day, f));
      const text = (m[2] ? gunzipSync(buf) : buf).toString('utf8');
      const snapshots: RtSnapshot[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          snapshots.push(decodeSnapshot(line));
        } catch {
          // Partial last line of an open file.
        }
      }
      out.push({ label: `${day}T${m[1]}`, open: !m[2], snapshots });
    }
  }
  return out;
}

/** Prepared plans by feed version, loaded on demand; `forTime` picks the feed for an instant. */
export async function planLoader() {
  const manifest = await readJson<FeedManifest>(join(PUBLIC_DATA_DIR, 'manifest.json'));
  const kin = await readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json'));
  const cache = new Map<string, PreparedPlan>();
  return {
    kin,
    async forTime(ms: number): Promise<PreparedPlan | undefined> {
      const feed = feedForDate(manifest, localDate(ms));
      if (!feed) return undefined;
      let pp = cache.get(feed.version);
      if (!pp) cache.set(feed.version, (pp = preparePlan(await readJson<ServicePlan>(join(FEEDS_OUT_DIR, feed.version, 'plan.json')), kin)));
      return pp;
    },
  };
}
