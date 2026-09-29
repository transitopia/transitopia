// Learn bus travel-time profiles from recorded GTFS-RT positions (PLAN.md §4.5):
//   data/rt-history/**  →  public/data/feeds/<version>/rt-profile.json (one per feed with data)
//
//   npm run build:rt-profile
// The live view uses the profile to predict buses between fixes; without one it falls back to the
// timetable. Rebuild as history accumulates. Check the effect with `npx tsx scripts/eval-rt.ts`.

import { join } from 'node:path';
import rtConfig from '@transitopia/region-metro-vancouver/config/rt.json' with { type: 'json' };
import { ProfileBuilder, type PredictionConfig } from '@transitopia/transit-core/rt/profile.ts';
import type { PreparedPlan } from '@transitopia/transit-core/schedule/engine.ts';
import { FEEDS_OUT_DIR, log, writeJson } from './lib/paths.ts';
import { loadRecordedHours, planLoader } from './lib/rt-history.ts';

async function main() {
  const cfg = rtConfig.prediction as unknown as PredictionConfig;
  const hours = await loadRecordedHours();
  if (!hours.length) {
    log('No recorded RT history (data/rt-history/); skipping');
    return;
  }
  const plans = await planLoader();
  const builders = new Map<PreparedPlan, ProfileBuilder>();
  for (const h of hours) {
    // Group each hour's snapshots by the feed in effect.
    const byPlan = new Map<PreparedPlan, typeof h.snapshots>();
    for (const s of h.snapshots) {
      const pp = await plans.forTime(s.fetchedAt);
      if (pp) (byPlan.get(pp) ?? byPlan.set(pp, []).get(pp)!).push(s);
    }
    for (const [pp, snaps] of byPlan) {
      let b = builders.get(pp);
      if (!b) builders.set(pp, (b = new ProfileBuilder(pp, cfg)));
      b.add(snaps, h.label);
    }
  }
  for (const [pp, b] of builders) {
    const profile = b.build();
    await writeJson(join(FEEDS_OUT_DIR, pp.plan.feedVersion, 'rt-profile.json'), profile);
    log(`${pp.plan.feedVersion}: profile for ${Object.keys(profile.shapes).length} shapes from ${profile.hours.length} recorded hours`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
