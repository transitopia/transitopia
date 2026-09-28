// Publish dispatch patches for dates with inputs (PLAN.md §4.11): re-dispatch each date that has
// observations or disruptions and write what changed against its base plan.
//   public/data/observations/*.json (from build:observations) + data/disruptions/*.json
//     → public/data/dispatch/<date>.json + index.json
//
//   npm run build:dispatch

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_DATA_DIR, ROOT, log, readJson, writeJson } from './lib/paths.ts';
import { DispatchContexts } from './lib/dispatch-context.ts';
import { dispatchDate } from '../src/core/dispatch/date.ts';
import type { DispatchIndex } from '../src/core/dispatch/patch.ts';
import type { Observation, ObservationFile, ObservationIndex } from '../src/core/corrections/types.ts';
import type { Disruption, DisruptionFile } from '../src/core/disruption/types.ts';
import { periodsOn } from '../src/core/disruption/apply.ts';
import { addDays } from '../src/core/time.ts';

/** Confirmed and draft disruptions from data/disruptions/*.json. */
export async function loadDisruptions(dir = join(ROOT, 'data', 'disruptions')): Promise<Disruption[]> {
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
function datesOf(d: Disruption): string[] {
  const dates = new Set<string>();
  for (const p of d.active) {
    // Candidates: the local dates of its start and end, and the day before (after-midnight service).
    const day = (iso: string) => new Date(Date.parse(iso) - 7 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
    for (const x of [day(p.from), day(p.until)]) for (const c of [addDays(x, -1), x]) if (periodsOn(d, c).length) dates.add(c);
  }
  return [...dates];
}

const OUT = join(PUBLIC_DATA_DIR, 'dispatch');

async function main() {
  const obsIndex = await readJson<ObservationIndex>(join(PUBLIC_DATA_DIR, 'observations', 'index.json')).catch(() => ({ schema: 1, byDate: {} }) as ObservationIndex);
  const contexts = new DispatchContexts();
  await rm(OUT, { recursive: true, force: true });
  const index: DispatchIndex = { schema: 1, byDate: {} };
  const builtAt = new Date().toISOString();
  const disruptions = await loadDisruptions();
  const dates = new Set(Object.keys(obsIndex.byDate));
  for (const d of disruptions) if (d.status !== 'draft') for (const x of datesOf(d)) dates.add(x);
  for (const date of [...dates].sort()) {
    const observations: Observation[] = [];
    for (const p of obsIndex.byDate[date] ?? []) observations.push(...(await readJson<ObservationFile>(join(ROOT, 'public', p))).observations);
    const ctx = await contexts.forDate(date);
    if (!ctx) {
      log(`${date}: no dispatched plan covers this date; skipped`);
      continue;
    }
    const t0 = performance.now();
    const patch = dispatchDate(ctx, { date, observations, disruptions }, builtAt);
    const path = `data/dispatch/${date}.json`;
    await writeJson(join(ROOT, 'public', path), patch);
    index.byDate[date] = { version: patch.version, path };
    const changed = patch.file ? `whole day re-planned (${patch.file.runs.length} runs)` : `${patch.runs.length} runs changed`;
    log(`${date}: ${patch.summary.inputs.join(', ') || 'no inputs'} → ${changed}; ${patch.summary.forced.length} forced; ${Math.round(performance.now() - t0)} ms`);
    for (const u of patch.unmatched) log(`    not applied (${u.reason}): ${JSON.stringify(u.obs).slice(0, 160)}`);
    for (const p of patch.problems ?? []) log(`    disruption problem: ${p}`);
  }
  await writeJson(join(OUT, 'index.json'), index, true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
