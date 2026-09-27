// Evaluate live bus prediction against recorded GTFS-RT data (PLAN.md §4.5).
//
// Builds a travel-time profile from the training hours, then replays the test hours: from each fix,
// predict where the bus will be at its next fixes and compare with where they actually put it
// (distance along the trip shape). Methods:
//   constant — last speed between the two previous fixes (the old live behaviour)
//   timetable — the timetable's running times with default stop dwells, adapted to the bus's pace
//   profile — learned profile (falling back to timetable), adapted to the bus's pace
//
//   npx tsx scripts/eval-rt.ts [--test 2026-09-26T16,2026-09-26T17] [--test-last 3] [--set paceWeight=0.3] [--no-live]
// Default: test on the last 3 complete hours, train on all other complete hours.
//
// Then replays the test hours as the live view sees them (each fix known only from the snapshot that
// first carried it) and measures what's displayed: jumps when a snapshot arrives, error against each
// fix at the moment it was taken, backward movement, and apparent speed.

import rtConfig from '../data/config/rt.json' with { type: 'json' };
import { cumulativeLengths, projectOnto, type LonLat } from '../src/core/geo.ts';
import { Predictor, ProfileBuilder, type PredictionConfig } from '../src/core/rt/profile.ts';
import { RtTimeline } from '../src/core/rt/timeline.ts';
import { distM } from '../src/core/geo.ts';
import type { RtVehicle } from '../src/core/rt/types.ts';
import type { PreparedPlan } from '../src/core/schedule/engine.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';
import { loadRecordedHours, planLoader, type RecordedHour } from './lib/rt-history.ts';
import { log } from './lib/paths.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// --set key=value[,key=value] overrides prediction settings, for tuning.
const cfg = { ...(rtConfig.prediction as unknown as PredictionConfig) };
for (const kv of opt('--set')?.split(',') ?? []) {
  const [k, v] = kv.split('=');
  (cfg as unknown as Record<string, unknown>)[k!] = JSON.parse(v!);
}

/** A fix placed on its trip shape. */
interface Placed {
  v: RtVehicle;
  along: number;
}

/** Each vehicle's fixes as runs on one trip, placed along the shape (deduplicated, in order). */
function tracks(hours: RecordedHour[], pp: PreparedPlan): Placed[][] {
  const byVehicle = new Map<string, RtVehicle[]>();
  for (const h of hours) for (const s of h.snapshots) for (const v of s.vehicles) if (v.tripId) (byVehicle.get(v.id) ?? byVehicle.set(v.id, []).get(v.id)!).push(v);
  const runs: Placed[][] = [];
  for (const list of byVehicle.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let run: Placed[] = [];
    for (const v of list) {
      const last = run[run.length - 1];
      if (last && v.ts === last.v.ts) continue;
      const trip = pp.tripIndex.get(v.tripId!);
      const coords = trip && (pp.plan.shapes[trip.pattern.shape] as LonLat[] | undefined);
      if (!trip || !coords) continue;
      if (last && (last.v.tripId !== v.tripId || v.ts - last.v.ts > 180_000)) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      const cum = pp.shapeCum.get(trip.pattern.shape) ?? cumulativeLengths(coords);
      const prev = run[run.length - 1];
      const p = projectOnto(coords, cum, [v.lon, v.lat], prev ? Math.max(0, prev.along - 50) : 0);
      if (p.offset > cfg.maxOffsetM) continue;
      run.push({ v, along: p.along });
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(f * b.length))]!;
};
const fmt = (a: number[]) => `p50 ${q(a, 0.5).toFixed(0).padStart(4)} m   p75 ${q(a, 0.75).toFixed(0).padStart(4)} m   p90 ${q(a, 0.9).toFixed(0).padStart(4)} m   (n=${a.length})`;

async function main() {
  const hours = (await loadRecordedHours()).filter((h) => !h.open && h.snapshots.length > 60);
  if (hours.length < 2) throw new Error('Need at least two complete recorded hours in data/rt-history/');
  const testLabels = opt('--test')?.split(',') ?? hours.slice(-Number(opt('--test-last') ?? 3)).map((h) => h.label);
  const test = hours.filter((h) => testLabels.includes(h.label));
  const train = hours.filter((h) => !testLabels.includes(h.label));
  const plans = await planLoader();
  const pp = await plans.forTime(test[0]!.snapshots[0]!.fetchedAt);
  if (!pp) throw new Error('No feed for the test hours');

  const builder = new ProfileBuilder(pp, cfg);
  for (const h of train) builder.add(h.snapshots, h.label);
  const profile = builder.build();
  log(`Train: ${train.length} h (${train[0]?.label}…${train.at(-1)?.label}); profile for ${Object.keys(profile.shapes).length} shapes`);
  log(`Test: ${test.map((h) => h.label).join(', ')}`);

  const withProfile = new Predictor(pp, cfg, profile);
  const timetable = new Predictor(pp, cfg);
  // Horizon buckets (s ahead of the fix the prediction starts from).
  const buckets: [string, number, number][] = [
    ['~30 s', 15, 45],
    ['~60 s', 45, 75],
    ['~90 s', 75, 110],
  ];
  const err: Record<string, Record<string, number[]>> = { constant: {}, timetable: {}, profile: {} };
  for (const run of tracks(test, pp)) {
    const trip = pp.tripIndex.get(run[0]!.v.tripId!)!;
    for (let k = 0; k < run.length; k++) {
      const f = run[k]!;
      const prev = k > 0 ? run[k - 1] : undefined;
      // Recent fixes within the pace window, for the pace factor.
      const recent = run.slice(0, k + 1).filter((x) => (f.v.ts - x.v.ts) / 1000 <= cfg.paceWindowS);
      let speed = 0;
      if (prev && (f.v.ts - prev.v.ts) / 1000 <= rtConfig.maxInterpolateS && f.along >= prev.along)
        speed = Math.min(25, (f.along - prev.along) / ((f.v.ts - prev.v.ts) / 1000));
      const cP = withProfile.course(trip, f.v.ts);
      const cT = timetable.course(trip, f.v.ts);
      const fP = withProfile.paceFactor(cP, recent.map((x) => ({ along: x.along, ts: x.v.ts })));
      const fT = timetable.paceFactor(cT, recent.map((x) => ({ along: x.along, ts: x.v.ts })));
      for (let j = k + 1; j < run.length; j++) {
        const g = run[j]!;
        const h = (g.v.ts - f.v.ts) / 1000;
        const b = buckets.find(([, lo, hi]) => h >= lo && h < hi);
        if (h >= 110) break;
        if (!b) continue;
        const add = (m: string, pred: number) => (err[m]![b[0]] ??= []).push(Math.abs(pred - g.along));
        add('constant', Math.min(cP.length, f.along + speed * h));
        add('timetable', timetable.walk(cT, f.along, h, fT).along);
        add('profile', withProfile.walk(cP, f.along, h, fP).along);
      }
    }
  }
  printPrediction(err, buckets);
  if (!args.includes('--no-live')) liveReplay(test, pp, plans.kin, new Predictor(pp, cfg, profile));
}

function printPrediction(err: Record<string, Record<string, number[]>>, buckets: [string, number, number][]) {
  console.log('\nPrediction error along the route (|predicted − actual| at later fixes):');
  for (const [name] of buckets) {
    console.log(`  ${name} ahead`);
    for (const m of Object.keys(err)) console.log(`    ${m.padEnd(10)} ${fmt(err[m]![name] ?? [])}`);
  }
}

/** Moved more than 5 m against the direction it was facing. */
function movedBackward(u: { lon: number; lat: number; bearing: number }, v: { lon: number; lat: number }): boolean {
  const dx = (v.lon - u.lon) * Math.cos((v.lat * Math.PI) / 180) * 111_320;
  const dy = (v.lat - u.lat) * 111_320;
  return dx * Math.sin((u.bearing * Math.PI) / 180) + dy * Math.cos((u.bearing * Math.PI) / 180) < -5;
}

/** Replays the test hours as the live view would show them, for the old and new methods. */
function liveReplay(test: RecordedHour[], pp: PreparedPlan, kin: KinematicsConfig, predictor: Predictor) {
  const snaps = test.flatMap((h) => h.snapshots).sort((a, b) => a.fetchedAt - b.fetchedAt);
  const WINDOW = 30; // snapshots of history per timeline (10 min), as the live client keeps
  const base = { maxInterpolateS: rtConfig.maxInterpolateS, maxExtrapolateS: rtConfig.maxExtrapolateS, source: 'eval' };
  const variants = {
    old: base,
    new: { ...base, prediction: { cfg, predictor } },
  };
  // Every fix, by the fetch index after which it was taken (so only earlier snapshots are known).
  const fetchTimes = snaps.map((s) => s.fetchedAt);
  const fixesAfter = new Map<number, RtVehicle[]>();
  const seen = new Set<string>();
  for (const s of snaps)
    for (const v of s.vehicles) {
      const key = `${v.id}@${v.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let k = -1;
      while (k + 1 < fetchTimes.length && fetchTimes[k + 1]! <= v.ts) k++;
      if (k >= WINDOW) (fixesAfter.get(k) ?? fixesAfter.set(k, []).get(k)!).push(v);
    }
  console.log('\nLive view replay (each fix known only once fetched):');
  for (const [name, opts] of Object.entries(variants)) {
    const jumps: number[] = [];
    const errors: number[] = [];
    const speeds: number[] = [];
    let backward = 0;
    let backJumps = 0;
    let steps = 0;
    for (let k = WINDOW; k < snaps.length - 1; k++) {
      const before = new RtTimeline(snaps.slice(k - WINDOW, k), pp, kin, opts);
      const now = new RtTimeline(snaps.slice(k - WINDOW + 1, k + 1), pp, kin, opts);
      const F = snaps[k]!.fetchedAt;
      const b = new Map(before.vehiclesAt(F).map((v) => [v.id, v]));
      for (const v of now.vehiclesAt(F)) {
        const u = b.get(v.id);
        if (!u) continue;
        jumps.push(distM([u.lon, u.lat], [v.lon, v.lat]));
        if (movedBackward(u, v)) backJumps++;
      }
      // Motion until the next snapshot, every 2 s.
      const next = snaps[k + 1]!.fetchedAt;
      let prev = new Map(now.vehiclesAt(F).map((v) => [v.id, v]));
      for (let t = F + 2000; t < next; t += 2000) {
        const cur = new Map(now.vehiclesAt(t).map((v) => [v.id, v]));
        for (const [id, v] of cur) {
          const u = prev.get(id);
          if (!u) continue;
          const d = distM([u.lon, u.lat], [v.lon, v.lat]);
          speeds.push(d / 2);
          steps++;
          if (movedBackward(u, v)) backward++;
        }
        prev = cur;
      }
      // Error against fixes taken before the next fetch, as shown at their own timestamps.
      for (const f of fixesAfter.get(k) ?? []) {
        const v = now.vehiclesAt(f.ts).find((x) => x.id === `rt:${f.id}`);
        if (v) errors.push(distM([v.lon, v.lat], [f.lon, f.lat]));
      }
    }
    console.log(`  ${name}`);
    console.log(`    jump when a snapshot arrives  ${fmt(jumps)}`);
    console.log(`    error vs fixes as shown live  ${fmt(errors)}`);
    const big = jumps.filter((j) => j > 50).length / jumps.length;
    console.log(`    jumps > 50 m: ${(big * 100).toFixed(1)}%   backward jumps: ${((backJumps / jumps.length) * 100).toFixed(1)}%   backward steps: ${((backward / steps) * 100).toFixed(2)}%   apparent speed p99 ${q(speeds, 0.99).toFixed(1)} m/s, max ${q(speeds, 1).toFixed(0)} m/s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
