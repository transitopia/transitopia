// Disruption files (data/disruptions/*.json): loading and the service dates they touch. Shared by
// build:dispatch and the RT service's live dispatch.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readJson } from './paths.ts';
import type { Disruption, DisruptionFile } from '../../src/core/disruption/types.ts';
import { periodsOn } from '../../src/core/disruption/apply.ts';
import { addDays, localDate } from '../../src/core/time.ts';

export const DISRUPTIONS_DIR = join(ROOT, 'data', 'disruptions');

/** Confirmed and draft disruptions from data/disruptions/*.json. */
export async function loadDisruptions(dir = DISRUPTIONS_DIR): Promise<Disruption[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Disruption[] = [];
  for (const f of files.sort()) out.push(...(await readJson<DisruptionFile>(join(dir, f))).disruptions);
  return out;
}

/** Service dates (YYYYMMDD) a disruption touches. */
export function datesOf(d: Disruption): string[] {
  const dates = new Set<string>();
  for (const p of d.active) {
    for (const iso of [p.from, p.until]) {
      const local = localDate(Date.parse(iso));
      // The local date, and the day before (service after midnight belongs to it).
      for (const c of [addDays(local, -1), local]) if (periodsOn(d, c).length) dates.add(c);
    }
  }
  return [...dates].sort();
}
