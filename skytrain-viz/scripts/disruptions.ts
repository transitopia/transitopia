// Review and confirm disruptions (PLAN.md §4.10–4.11, M8.5).
//
//   npm run disruptions                               # list confirmed, drafts, and alerts we couldn't parse
//   npm run disruptions -- pull [--from <url>]        # draft from the running RT service's /rt/alerts
//   npm run disruptions -- confirm <id> [--keep "<platform stop>"]
//   npm run disruptions -- discard <id>
//
// The RT service drafts disruptions from TransLink alerts into data/disruptions/drafts/ (gitignored).
// A draft applies only once confirmed: that writes data/disruptions/<id>.json with status "confirmed"
// (commit it), after checking which track stays open, which alerts rarely say.

import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import rtConfig from '../data/config/rt.json' with { type: 'json' };
import { ROOT, log } from './lib/paths.ts';
import { DISRUPTIONS_DIR, loadDisruptions } from './lib/disruptions.ts';
import { AlertDrafts } from '../server/rt/alerts.ts';
import type { ServiceAlert } from '../src/core/disruption/alerts.ts';
import type { Disruption, DisruptionFile } from '../src/core/disruption/types.ts';

const DRAFTS = join(DISRUPTIONS_DIR, 'drafts');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function drafts(): Promise<Disruption[]> {
  try {
    const files = (await readdir(DRAFTS)).filter((f) => f.endsWith('.json') && f !== 'unparsed.json');
    const out: Disruption[] = [];
    for (const f of files.sort()) out.push(...(JSON.parse(await readFile(join(DRAFTS, f), 'utf8')) as DisruptionFile).disruptions);
    return out;
  } catch {
    return [];
  }
}

const periods = (d: Disruption) => d.active.map((p) => `${new Date(p.from).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })} → ${new Date(p.until).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })}`).join('; ');
const describe = (d: Disruption) =>
  [
    ...(d.singleTrack ?? []).map((s) => `single track ${s.line} ${s.between.join('–')}, open track through ${s.keep || '??? (set with --keep)'}${s.pinEnds ? ' (ends too)' : ''}`),
    ...(d.headway ?? []).map((h) => `every ${h.minS / 60} min: ${h.line}${h.between ? ` ${h.between.join('–')}` : ''}`),
  ].join('; ');

async function list() {
  const confirmed = (await loadDisruptions()).filter((d) => d.status !== 'draft');
  console.log(`Confirmed (${confirmed.length}):`);
  for (const d of confirmed) console.log(`  ${d.id}: ${d.text}\n    ${describe(d)}\n    ${periods(d)}`);
  const ds = await drafts();
  console.log(`Drafts (${ds.length}), confirm with: npm run disruptions -- confirm <id> [--keep "<platform stop>"]`);
  for (const d of ds) console.log(`  ${d.id}: ${d.text}\n    ${describe(d)}\n    ${periods(d)}`);
  const unparsed = JSON.parse(await readFile(join(DRAFTS, 'unparsed.json'), 'utf8').catch(() => '[]')) as { id: string; lines: string[]; header: string; reason: string }[];
  if (unparsed.length) console.log(`Alerts without a draft (${unparsed.length}); write a disruption by hand if one matters:`);
  for (const u of unparsed) console.log(`  ${u.id} [${u.lines.join(', ')}] ${u.header.slice(0, 100)} (${u.reason})`);
}

async function pull() {
  const from = opt('--from') ?? `http://localhost:${rtConfig.serverPort}`;
  const res = await fetch(`${from.replace(/\/$/, '')}/rt/alerts`);
  if (!res.ok) throw new Error(`${from}/rt/alerts: HTTP ${res.status}`);
  const { alerts } = (await res.json()) as { alerts: (ServiceAlert & { drafted?: boolean })[] };
  await new AlertDrafts({ disruptionsDir: DISRUPTIONS_DIR, historyDir: join(ROOT, 'data', 'rt-history'), log }).update(alerts.map(({ drafted: _d, ...a }) => a));
  await list();
}

async function confirm(id: string) {
  const path = join(DRAFTS, `${id}.json`);
  const file = JSON.parse(await readFile(path, 'utf8')) as DisruptionFile;
  const keep = opt('--keep');
  for (const d of file.disruptions) {
    for (const s of d.singleTrack ?? []) {
      if (keep) s.keep = keep;
      if (!s.keep) throw new Error(`${d.id}: which track stays open between ${s.between.join(' and ')}? Pass --keep "<platform stop>"`);
    }
    d.status = 'confirmed';
  }
  const out: DisruptionFile = { $comment: `Confirmed ${new Date().toISOString().slice(0, 10)} from a draft of TransLink alert ${file.disruptions[0]?.alertId ?? ''}.`, disruptions: file.disruptions };
  await writeFile(join(DISRUPTIONS_DIR, `${id}.json`), JSON.stringify(out, null, 2) + '\n');
  await rm(path);
  log(`Confirmed ${id} → data/disruptions/${id}.json (commit it). The RT service applies it within ${rtConfig.dispatchCheckS} s; run npm run build:dispatch for the static site.`);
}

async function main() {
  const [cmd, id] = args;
  if (!cmd || cmd.startsWith('--')) return list();
  if (cmd === 'pull') return pull();
  if (cmd === 'confirm' && id) return confirm(id);
  if (cmd === 'discard' && id) {
    await rm(join(DRAFTS, `${id}.json`));
    return log(`Discarded draft ${id}`);
  }
  throw new Error('Usage: npm run disruptions [-- pull [--from <url>] | confirm <id> [--keep "<stop>"] | discard <id>]');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
