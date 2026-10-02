// Rebuild all data in order (pipelines/README.md): latest GTFS → service plans → track network → platform
// mapping → movements → validation. OSM tracks are committed (regions/metro-vancouver/infrastructure/), so they are only
// re-fetched with --osm.
//
//   npm run data            # typical: new timetable, same tracks
//   npm run data -- --osm   # also re-fetch and re-import OpenStreetMap tracks

import { spawnSync } from "node:child_process";
import { log } from "./lib/paths.ts";

const steps: [string, string[]][] = [
  ["Fetch latest GTFS", ["pipelines/fetch-gtfs.ts"]],
  ["Build service plans", ["pipelines/build-schedule.ts"]],
  ...(process.argv.includes("--osm") ?
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

for (const [name, args] of steps) {
  log(`▶ ${name}`);
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    log(`✖ ${name} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
log("✔ Data up to date");
