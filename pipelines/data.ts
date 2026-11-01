// Rebuild all data in order (pipelines/README.md): latest GTFS → OSM roads → service plans → track
// network → platform mapping → plan and overview tiles → movements → validation → the cycling map's
// tiles and routes (from the cycling OSM file GitHub Actions publishes; packages/cycling-core/README.md#building-the-tiles:
// neither step stops the build, and without a new file the last one is built again). OSM tracks are committed
// (config/networks/skytrain/infrastructure/), so they aren't fetched here: `npm run data:osm` re-imports
// them. OSM roads (for bus corridors) aren't committed: they're fetched for a feed without them, or once
// they're ROADS_MAX_AGE_DAYS old (`npm run data:roads` fetches every feed's now). A failed roads fetch
// doesn't stop the build: plans are built with the roads already fetched, or without corridors.
//
// Last, the places files (docs/DESIGN.md#published-features) from the local database's registry, pulled from
// production first when there's none (optional: without them the site names features by ref).
// The server's data build writes its own after reconciling (TRANSITOPIA_SKIP_PLACES).
//
// Name targets to build only some of it: transit, cycling, and basemap (pipelines/tiles.ts --region bc,
// skipped when the extract exists). With none, transit and cycling (what the server's data build runs).
//
//   npm run data                          # typical: new timetable, same tracks
//   npm run data basemap transit cycling  # everything a local setup needs

import { spawnSync } from "node:child_process";
import { log } from "@transitopia/data/paths.ts";

/** OSM roads older than this are fetched again (a guess: bus loops and new roads change rarely). */
const ROADS_MAX_AGE_DAYS = 30;
const TARGETS = ["transit", "cycling", "basemap"] as const;
type Target = (typeof TARGETS)[number];
const named = process.argv.slice(2);
for (const a of named)
  if (!TARGETS.includes(a as Target)) {
    console.error(`Unknown target "${a}" (expected ${TARGETS.join(", ")})`);
    process.exit(2);
  }
const targets = new Set<Target>(
  named.length ? (named as Target[]) : ["transit", "cycling"],
);

type Step = [name: string, args: string[], optional?: boolean];

const basemap: Step[] = [
  ["Make the basemap", ["pipelines/tiles.ts", "--region", "bc"]],
];

/** [name, script and arguments, whether the build can go on without it]. */
const transit: Step[] = [
  ["Fetch latest GTFS", ["pipelines/fetch-gtfs.ts"]],
  [
    "Fetch OSM roads",
    [
      "pipelines/fetch-osm-roads.ts",
      "--max-age-days",
      String(ROADS_MAX_AGE_DAYS),
    ],
    true,
  ],
  ["Build service plans", ["pipelines/build-schedule.ts"]],
  ["Validate track network", ["pipelines/validate-infra.ts"]],
  ["Publish tracks and platforms", ["pipelines/build-infra.ts"]],
  ["Make plan tiles", ["pipelines/build-plan-tiles.ts"]],
  ["Make the overview tiles", ["pipelines/build-overview-tiles.ts"]],
  ["Infer and dispatch train runs", ["pipelines/build-movements.ts"]],
  ["Publish observations", ["pipelines/build-observations.ts"]],
  ["Dispatch dates with observations", ["pipelines/build-dispatch.ts"]],
  ["Learn bus travel-time profiles", ["pipelines/build-rt-profile.ts"]],
  ["Validate movements", ["pipelines/validate-plan.ts"]],
];

const cycling: Step[] = [
  ["Fetch the cycling OSM file", ["pipelines/fetch-cycling-osm.ts"], true],
  ["Make the cycling tiles", ["pipelines/build-cycling.ts"], true],
];

const places: Step[] =
  process.env.TRANSITOPIA_SKIP_PLACES ?
    []
  : [
      [
        "Write places files",
        ["apps/server/src/cli/features.ts", "places"],
        true,
      ],
    ];

const steps: Step[] = [
  ...(targets.has("basemap") ? basemap : []),
  ...(targets.has("transit") ? transit : []),
  ...(targets.has("cycling") ? cycling : []),
  ...(targets.has("transit") || targets.has("cycling") ? places : []),
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
