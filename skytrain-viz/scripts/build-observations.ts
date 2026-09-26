// Validate and publish observation files (PLAN.md §4.7):
//   data/observations/*.json → public/data/observations/<name>.json + index.json (by service date)
//
//   npm run build:observations

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, PUBLIC_DATA_DIR, log, readJson, writeJson } from './lib/paths.ts';
import type { Observation, ObservationFile, ObservationIndex } from '../src/core/corrections/types.ts';

const SRC = join(ROOT, 'data', 'observations');
const OUT = join(PUBLIC_DATA_DIR, 'observations');
const KINDS = new Set(['at_platform', 'delay', 'cancel', 'consist', 'parked']);

function problems(o: Observation): string[] {
  const p: string[] = [];
  if (!KINDS.has(o.kind)) p.push(`unknown kind "${(o as { kind: string }).kind}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? '')) p.push('date must be YYYY-MM-DD');
  if (!o.source) p.push('source is required');
  if (o.kind === 'at_platform') {
    if (!o.stop) p.push('stop is required');
    if (!o.time || Number.isNaN(Date.parse(o.time))) p.push('time must be ISO 8601 with offset');
  } else if (o.kind === 'parked') {
    if (!Array.isArray(o.at) || o.at.length !== 2) p.push('at must be [lon, lat]');
    if (!o.time || Number.isNaN(Date.parse(o.time))) p.push('time must be ISO 8601 with offset');
  } else if (!('trip' in o) || !o.trip) p.push('trip is required');
  if (o.kind === 'delay' && !Number.isFinite(o.seconds)) p.push('seconds must be a number');
  return p;
}

async function main() {
  let files: string[] = [];
  try {
    files = (await readdir(SRC)).filter((f) => f.endsWith('.json'));
  } catch {
    // No observations directory.
  }
  await rm(OUT, { recursive: true, force: true });
  const index: ObservationIndex = { schema: 1, byDate: {} };
  let count = 0;
  let bad = 0;
  for (const f of files) {
    const data = await readJson<ObservationFile>(join(SRC, f));
    const valid: Observation[] = [];
    data.observations.forEach((o, i) => {
      const p = problems(o);
      if (p.length) {
        bad++;
        log(`  ${f} #${i}: ${p.join('; ')}`);
      } else valid.push(o);
    });
    await writeJson(join(OUT, f), { observations: valid });
    for (const d of new Set(valid.map((o) => o.date.replaceAll('-', '')))) (index.byDate[d] ??= []).push(`data/observations/${f}`);
    count += valid.length;
  }
  await writeJson(join(OUT, 'index.json'), index, true);
  log(`Published ${count} observations from ${files.length} files (${bad} invalid, skipped)`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
