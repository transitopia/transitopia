// Rebuild all data in order (PLAN.md §4): latest GTFS → service plans → track network → platform
// mapping → movements → validation. OSM tracks are committed (data/infrastructure/), so they are only
// re-fetched with --osm.
//
//   npm run data            # typical: new timetable, same tracks
//   npm run data -- --osm   # also re-fetch and re-import OpenStreetMap tracks

import { spawnSync } from 'node:child_process';
import { log } from './lib/paths.ts';

const steps: [string, string[]][] = [
  ['Fetch latest GTFS', ['scripts/fetch-gtfs.ts']],
  ['Build service plans', ['scripts/build-schedule.ts']],
  ...(process.argv.includes('--osm')
    ? ([
        ['Fetch OSM tracks', ['scripts/fetch-osm.ts']],
        ['Import OSM tracks', ['scripts/import-osm.ts']],
      ] as [string, string[]][])
    : []),
  ['Validate track network', ['scripts/validate-infra.ts']],
  ['Publish tracks and platforms', ['scripts/build-infra.ts']],
  ['Infer train runs', ['scripts/build-movements.ts']],
  ['Publish observations', ['scripts/build-observations.ts']],
  ['Validate movements', ['scripts/validate-plan.ts']],
];

for (const [name, args] of steps) {
  log(`▶ ${name}`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    log(`✖ ${name} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
log('✔ Data up to date');
