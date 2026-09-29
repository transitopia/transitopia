// Evaluate recorded SeaBus AIS fixes against the timetable (PLAN.md §4.12): how many fixes match a
// trip, how late each vessel ran, which vessel ran which block, and which berths were used.
//
//   npx tsx scripts/eval-ais.ts [YYYYMMDD]      # default: today's service date

import { join } from 'node:path';
import { CONFIG_DIR, INFRA_DIR, AIS_HISTORY_DIR, readJson } from './lib/paths.ts';
import { loadLatestPlan } from './lib/infra.ts';
import { Recorder } from '@transitopia/server/rt/recorder.ts';
import { readRecordedFixes } from '@transitopia/server/rt/ais.ts';
import { aisCorrections, type AisMatchConfig } from '@transitopia/transit-core/ais/match.ts';
import { preparePlan } from '@transitopia/transit-core/schedule/engine.ts';
import { distM, type LonLat } from '@transitopia/transit-core/geo.ts';
import { formatServiceTime, localDate, serviceDayStart } from '@transitopia/transit-core/time.ts';

const kin = await readJson<any>(join(CONFIG_DIR, 'kinematics.json'));
const seabus = await readJson<any>(join(CONFIG_DIR, 'seabus.json'));
const infra = await readJson<any>(join(INFRA_DIR, 'seabus.json'));
const cfg = Object.fromEntries(Object.entries(seabus.ais.match).filter(([k]) => !k.startsWith('$'))) as unknown as AisMatchConfig;
const names = new Map<string, string>(seabus.ais.vessels.map((v: any) => [v.mmsi, v.name]));

const date = process.argv[2] ?? (new Date().getHours() < 3 ? localDate(Date.now() - 86_400_000) : localDate(Date.now()));
const pp = preparePlan(await loadLatestPlan(), kin);
const fixes = (await readRecordedFixes(new Recorder(AIS_HISTORY_DIR, 75_000), date)).map((f) => ({ ...f, name: names.get(f.mmsi) ?? f.name }));
if (!fixes.length) {
  console.log(`No recorded AIS fixes for ${date} (data/ais-history/).`);
  process.exit(0);
}
const r = aisCorrections(pp, date, fixes, 'seabus', cfg);
const dayStart = serviceDayStart(date);
const hm = (ms: number) => formatServiceTime((ms - dayStart) / 1000, true);
console.log(`${date}: ${fixes.length} fixes ${hm(fixes[0]!.ts)}–${hm(fixes.at(-1)!.ts)}; matched ${r.matched}, unmatched ${r.unmatched}`);
console.log(`Berth pair: ${r.pair ?? '(plan has none)'}${r.pair && r.pair !== pp.plan.ferry?.default ? ` (overrides the default, ${pp.plan.ferry?.default})` : ''}`);

console.log('\nVessels per block:');
for (const [block, v] of r.vessels) console.log(`  ${block}: ${v.name ?? v.mmsi} (${v.fixes} fixes)`);

console.log('\nObserved trips (last anchor = lateness when last seen):');
for (const [tripId, c] of r.corrections.trips) {
  const trip = pp.tripIndex.get(tripId)!;
  const last = c.anchors.at(-1)!;
  const tag = c.estimate ? `carried: ${c.estimate}` : `${c.observed.length} fixes, ${last.shift >= 0 ? '+' : ''}${Math.round(last.shift)} s`;
  console.log(`  ${formatServiceTime(trip.trip.start)} ${trip.trip.headsign.padEnd(28)} ${trip.vehicleId.split(':').pop()}  ${tag}`);
}

// Stationary fixes near a berth: which berth pair is in use.
const berths: { name: string; dock: LonLat }[] = [];
for (const [t, term] of Object.entries<any>(infra.terminals)) for (const [b, berth] of Object.entries<any>(term.berths)) berths.push({ name: `${t} ${b}`, dock: berth.dock });
const seen = new Map<string, number>();
for (const f of fixes) {
  if ((f.sog ?? 99) > cfg.stationaryKn) continue;
  const near = berths.map((b) => ({ b, d: distM([f.lon, f.lat], b.dock) })).sort((a, b) => a.d - b.d)[0]!;
  const k = `${names.get(f.mmsi) ?? f.mmsi} @ ${near.d <= cfg.dockRadiusM ? `${near.b.name} berth` : 'away from the passenger berths (e.g. layup)'}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
console.log('\nStationary fixes:');
for (const [k, n] of [...seen].sort()) console.log(`  ${k}: ${n}`);
