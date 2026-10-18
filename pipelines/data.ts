// Rebuild all data in order (pipelines/README.md): latest GTFS → OSM roads → service plans → track
// network → platform mapping → movements → validation. OSM tracks are committed
// (config/regions/metro-vancouver/infrastructure/), so they are only re-fetched with --osm. OSM roads
// (for bus corridors) aren't: they're fetched for a feed without them, or once they're
// ROADS_MAX_AGE_DAYS old (every feed with --osm). A failed roads fetch doesn't stop the build:
// plans are built with the roads already fetched, or without corridors.
//
//   npm run data            # typical: new timetable, same tracks
//   npm run data -- --osm   # also re-fetch and re-import OpenStreetMap tracks

import { spawnSync } from "node:child_process";
import { log } from "@transitopia/data/paths.ts";

/** OSM roads older than this are fetched again (a guess: bus loops and new roads change rarely). */
const ROADS_MAX_AGE_DAYS = 30;
const osm = process.argv.includes("--osm");

/** [name, script and arguments, whether the build can go on without it]. */
const steps: [string, string[], boolean?][] = [
  ["Fetch latest GTFS", ["pipelines/fetch-gtfs.ts"]],
  [
    "Fetch OSM roads",
    [
      "pipelines/fetch-osm-roads.ts",
      ...(osm ? [] : ["--max-age-days", String(ROADS_MAX_AGE_DAYS)]),
    ],
    true,
  ],
  ["Build service plans", ["pipelines/build-schedule.ts"]],
  ...(osm ?
    ([
      ["Fetch OSM tracks", ["pipelines/fetch-osm.ts"]],
      ["Import OSM tracks", ["pipelines/import-osm.ts"]],
    ] as [string, string[]][])
  : []),
  ["Validate track network", ["pipelines/validate-infra.ts"]],
  ["Publish tracks and platforms", ["pipelines/build-infra.ts"]],
  ["Infer and dispatch train runs", ["pipelines/build-movements.ts"]],
  ["Publish observations", ["pipelines/build-observations.ts"]],
  ["Dispatch dates with observations", ["pipelines/build-dispatch.ts"]],
  ["Learn bus travel-time profiles", ["pipelines/build-rt-profile.ts"]],
  ["Validate movements", ["pipelines/validate-plan.ts"]],
];

for (const [name, args, optional] of steps) {
  log(`▶ ${name}`);
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    stdio: "inherit",
  });
  if (r.status !== 0 && optional) {
    log(`✖ ${name} failed (exit ${r.status}); carrying on without it`);
  } else if (r.status !== 0) {
    log(`✖ ${name} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
log("✔ Data up to date");
