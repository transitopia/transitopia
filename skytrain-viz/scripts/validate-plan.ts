// Validate built movement files (PLAN.md §7): continuity (no teleports), conflicts (two trains on the
// same piece of track at once), and fleet in service over the day.
//
//   npm run validate:plan [-- --key 1+1101] [--step 5]

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { CONFIG_DIR, FEEDS_OUT_DIR, readJson } from './lib/paths.ts';
import { loadAllPlans, loadGraph } from './lib/infra.ts';
import { preparePlan } from '../src/core/schedule/engine.ts';
import { TrainPlayback } from '../src/core/movement/playback.ts';
import type { MovementsFile } from '../src/core/movement/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';
import type { OperationsConfig } from '../src/core/movement/build.ts';
import { distM } from '../src/core/geo.ts';
import { formatServiceTime } from '../src/core/time.ts';

/** Largest plausible movement between samples: 90 km/h. */
const MAX_SPEED_MS = 25;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const { graph } = await loadGraph();
  const kin = await readJson<KinematicsConfig>(join(CONFIG_DIR, 'kinematics.json'));
  const ops = await readJson<OperationsConfig>(join(CONFIG_DIR, 'operations.json'));
  const step = Number(arg('--step') ?? 5);
  let failures = 0;
  for (const plan of await loadAllPlans()) {
    const pp = preparePlan(plan, kin);
    const dir = join(FEEDS_OUT_DIR, plan.feedVersion, 'movements');
    const keys = (await readdir(dir)).filter((f) => f !== 'index.json').map((f) => f.replace(/\.json$/, ''));
    for (const key of keys.filter((k) => !arg('--key') || k === arg('--key'))) {
      const file = await readJson<MovementsFile>(join(dir, `${key}.json`));
      const pb = new TrainPlayback(file, pp, graph, kin, { deadheadSpeedFactor: ops.yard.deadheadSpeedFactor });
      const last = new Map<string, { lon: number; lat: number; t: number }>();
      const jumps = new Map<string, { t: number; d: number }>();
      const conflicts = new Map<string, { t: number; d: number }>();
      const byPlace = new Map<string, number>();
      const nearestStation = (lon: number, lat: number) =>
        plan.stations.reduce((b, st) => {
          const d = distM([st.lon, st.lat], [lon, lat]);
          return d < b.d ? { d, name: st.name } : b;
        }, { d: Infinity, name: '' });
      const fleet = new Map<string, number>();
      const fleetAt = new Map<string, [number, number]>();
      for (let t = 3 * 3600; t <= 28 * 3600; t += step) {
        const vs = pb.vehiclesAt(t, plan.feedStart);
        const count = new Map<string, number>();
        for (const v of vs) {
          count.set(v.routeKey, (count.get(v.routeKey) ?? 0) + 1);
          const prev = last.get(v.id);
          if (prev && t - prev.t <= step) {
            const d = distM([prev.lon, prev.lat], [v.lon, v.lat]);
            if (d > MAX_SPEED_MS * step + 50 && !jumps.has(v.id)) jumps.set(v.id, { t, d });
          }
          last.set(v.id, { lon: v.lon, lat: v.lat, t });
        }
        for (const [line, n] of count) {
          if (n > (fleet.get(line) ?? 0)) {
            fleet.set(line, n);
            fleetAt.set(line, [n, t]);
          }
        }
        // Conflicts: two trains overlapping on the same track segment.
        const bySeg = new Map<string, typeof vs>();
        for (const v of vs) if (v.track) (bySeg.get(v.track.seg) ?? bySeg.set(v.track.seg, []).get(v.track.seg)!).push(v);
        for (const list of bySeg.values()) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              const a = list[i]!;
              const b = list[j]!;
              const gap = Math.abs(a.track!.offset - b.track!.offset);
              if (gap < (a.length + b.length) / 2) {
                const k = [a.id, b.id].sort().join(' & ');
                if (!conflicts.has(k)) {
                  conflicts.set(k, { t, d: gap });
                  const st = nearestStation(a.lon, a.lat);
                  const where = `${st.d < 400 ? st.name : `near ${st.name}`} (${[a.status, b.status].sort().join(' + ')})`;
                  byPlace.set(where, (byPlace.get(where) ?? 0) + 1);
                }
              }
            }
          }
        }
      }
      console.log(
        `${plan.feedVersion} [${key}]: ${file.runs.length} runs; peak trains visible: ` +
          [...fleetAt].map(([l, [n, t]]) => `${l} ${n} @${formatServiceTime(t)}`).join(', '),
      );
      for (const [id, j] of [...jumps].slice(0, 10)) console.log(`  teleport: ${id} jumps ${Math.round(j.d)} m at ${formatServiceTime(j.t, true)}`);
      if (jumps.size > 10) console.log(`  … ${jumps.size - 10} more teleports`);
      if (conflicts.size) {
        console.log(`  ${conflicts.size} conflicting pairs (two trains overlapping on one track); top places:`);
        for (const [where, n] of [...byPlace].sort((x, y) => y[1] - x[1]).slice(0, Number(arg('--top') ?? 8))) console.log(`    ${String(n).padStart(4)}  ${where}`);
      }
      if (process.argv.includes('--verbose')) {
        for (const [pair, c] of conflicts) console.log(`  conflict: ${pair} (${Math.round(c.d)} m between centres) at ${formatServiceTime(c.t, true)}`);
      }
      failures += jumps.size;
    }
  }
  console.log(failures ? `${failures} teleports` : 'OK: no teleports');
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
