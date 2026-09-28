// Publish dispatch patches for dates with inputs (PLAN.md §4.11): re-dispatch each date that has
// observations and write what changed against its base plan.
//   public/data/observations/*.json (from build:observations) → public/data/dispatch/<date>.json + index.json
//
//   npm run build:dispatch

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_DATA_DIR, ROOT, log, readJson, writeJson } from './lib/paths.ts';
import { DispatchContexts } from './lib/dispatch-context.ts';
import { dispatchDate } from '../src/core/dispatch/date.ts';
import type { DispatchIndex } from '../src/core/dispatch/patch.ts';
import type { Observation, ObservationFile, ObservationIndex } from '../src/core/corrections/types.ts';

const OUT = join(PUBLIC_DATA_DIR, 'dispatch');

async function main() {
  const obsIndex = await readJson<ObservationIndex>(join(PUBLIC_DATA_DIR, 'observations', 'index.json')).catch(() => ({ schema: 1, byDate: {} }) as ObservationIndex);
  const contexts = new DispatchContexts();
  await rm(OUT, { recursive: true, force: true });
  const index: DispatchIndex = { schema: 1, byDate: {} };
  const builtAt = new Date().toISOString();
  for (const [date, paths] of Object.entries(obsIndex.byDate).sort()) {
    const observations: Observation[] = [];
    for (const p of paths) observations.push(...(await readJson<ObservationFile>(join(ROOT, 'public', p))).observations);
    const ctx = await contexts.forDate(date);
    if (!ctx) {
      log(`${date}: no dispatched plan covers this date; skipped`);
      continue;
    }
    const t0 = performance.now();
    const patch = dispatchDate(ctx, { date, observations }, builtAt);
    const path = `data/dispatch/${date}.json`;
    await writeJson(join(ROOT, 'public', path), patch);
    index.byDate[date] = { version: patch.version, path };
    log(`${date}: ${patch.summary.inputs.join(', ') || 'no inputs'} → ${patch.runs.length} runs changed; ${patch.unmatched.length} unmatched; ${Math.round(performance.now() - t0)} ms`);
    for (const u of patch.unmatched) log(`    not applied (${u.reason}): ${JSON.stringify(u.obs).slice(0, 160)}`);
  }
  await writeJson(join(OUT, 'index.json'), index, true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
