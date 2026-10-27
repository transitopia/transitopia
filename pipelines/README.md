# Pipelines

Build-time data pipelines, validators and tools, run from the repo root (`npm run …` or `npx tsx pipelines/<name>.ts`). They write to `var/` (gitignored); [`@transitopia/data`](../packages/data/README.md)'s `paths.ts` is the one place that knows where data lives, and holds the data access the server shares with them (GTFS zips, disruption files, the track graph, dispatch contexts). The models they build are described in [packages/transit-core/DESIGN.md](../packages/transit-core/DESIGN.md). In production the server runs the build steps daily ([apps/server → Jobs](../apps/server/README.md#jobs)).

## Building the transit data

`npm run data` runs every step in order. The steps:

| Command | Script | What |
|---|---|---|
| `npm run data:gtfs` | `fetch-gtfs.ts`, `build-schedule.ts`, `build-plan-tiles.ts`, `build-overview-tiles.ts` | Fetch every feed's latest GTFS (`config/feeds/*/feed.json`; `--feed <id>`, and `--history <date>` for a dated snapshot where the feed has them), archive it by feed version (skipping a download with the same files as the newest archived, or only past dates dropped from it), build a service plan per version and each feed's manifest ([Timetables](../packages/transit-core/DESIGN.md#timetables)). One feed failing doesn't stop the others. |
| `npm run data:osm` | `fetch-osm.ts`, `import-osm.ts` | Fetch SkyTrain track from OSM (Overpass) for a region's bbox and import it into `config/regions/<region>/infrastructure/*.generated.geojson` (`-- --region <id>`; default: the region with track-level rail) ([Track graph](../packages/transit-core/DESIGN.md#track-graph)) |
| `npm run data:roads` | `fetch-osm-roads.ts` | Fetch the roads each feed's buses can use from OSM (Overpass) into `var/raw/osm-roads/<feed>/` (`-- --feed <id>`; `--max-age-days <n>` only fetches feeds without roads or with older ones, as `npm run data` does with 30 and the server's nightly build with it, keeping the newest three extracts). With them, `build-schedule` matches bus shapes to the roads and builds bus corridors ([Bus corridors](../packages/transit-core/DESIGN.md#bus-corridors)); without them, plans keep the GTFS shapes |
| `npm run build:infra` | `build-infra.ts` | Publish Metro Vancouver's track network (`infra/tracks.geojson`), its line geometry for drawing (`infra/lines.geojson`: centrelines, ribbons and tracks, split into service track, where any feed version's trains run between platforms, and the rest) and the per-version platform mapping of TransLink's feed |
| `npm run build:plan-tiles` | `build-plan-tiles.ts` | Each plan's tiles, with SkyTrain's track where its region has it, named by a hash of their input so plans whose lines didn't change share them; plan.json names them (`--feed <id>`; [Plan tiles](../packages/transit-core/DESIGN.md#plan-tiles)). Needs tippecanoe 2.17 or later (`brew install tippecanoe`, or `TIPPECANOE=<path>`) |
| `npm run build:overview-tiles` | `build-overview-tiles.ts` | Every feed's routes for today at low zoom, coloured as the map's "Day": `var/public/tiles/transit-overview-v<N>.pmtiles` ([Overview tiles](../packages/transit-core/DESIGN.md#overview-tiles)) |
| `npm run build:movements` | `build-movements.ts` | Infer runs and dispatch them, per service-day type (`--verbose`, `--no-dispatch`) ([Run inference](../packages/transit-core/DESIGN.md#run-inference), [Dispatcher](../packages/transit-core/DESIGN.md#dispatcher)) |
| `npm run build:observations` | `build-observations.ts` | Validate and publish observation files |
| `npm run build:dispatch` | `build-dispatch.ts` | Re-dispatch dates with observations or disruptions into per-date patches |
| `npm run build:rt-profile` | `build-rt-profile.ts` | Learn bus travel-time profiles from each feed's recorded history (`--feed <id>`) ([Buses](../packages/transit-core/DESIGN.md#buses)) |
| `npm run scenario -- <name>` | `scenario.ts` | Build a scenario ([Scenarios](../packages/transit-core/DESIGN.md#scenarios)) |
| `npm run tiles -- --region bc` | `tiles.ts` | The basemap: a BC extract of the Protomaps daily build (~2 GB), plus fonts and sprites |

After changing infrastructure, config or pipeline code, rebuild and run both validators.

## Building the cycling tiles

`npm run data:cycling` runs `fetch-cycling-osm.ts` (the cycling OSM file GitHub Actions publishes daily, into `var/raw/osm-cycling/<area>/`) and `build-cycling.ts` (`npm run build:cycling`: the classification in `packages/cycling-core`, then tippecanoe, into `var/public/tiles/transitopia-cycling-<area>.pmtiles`). `extract-cycling-osm.ts` (`npm run extract:cycling-osm`) makes that OSM file from Geofabrik's extract with osmium, as the workflow does. `inspect-cycling-tiles.ts` shows what a cycling tileset holds and compares two. See [packages/cycling-core](../packages/cycling-core/README.md#building-the-tiles).

## Validators

- `npm run validate:infra` (`validate-infra.ts`): the track graph against GTFS and the diagram checklist. Exits non-zero on failure.
- `npm run validate:plan` (`validate-plan.ts`): built movement files: teleports (fail), conflicts, dispatch delays, broken deadlocks and fleet peaks (report).

What they check is in [packages/transit-core/DESIGN.md → Validation](../packages/transit-core/DESIGN.md#validation). CI runs both against a pinned GTFS snapshot.

## Tools

| Command | What |
|---|---|
| `npm run disruptions` | Without a database: list, confirm or discard drafted disruptions (production uses `/admin`) |
| `npm run snapshot:pull -- --from <date> --to <date> [--db]` | Pull production recordings (and a database snapshot) into `var/` ([deployment/README.md → Snapshots](../deployment/README.md#snapshots-for-development)) |
| `npx tsx pipelines/eval-rt.ts` | Replay recorded RT data as the live view would: prediction error and jumps (`--feed <id>`, default TransLink; `--subsample schedule` thins it to the feed's poll schedule) |
| `npx tsx pipelines/probe-ais.ts` | Record raw aisstream.io messages for the SeaBus fleet and summarise them |
| `npx tsx pipelines/eval-gpx.ts [<file.gpx> ...]` | GPX ridden on a bus (`config/regions/metro-vancouver/observations/gpx/*-B<bus>-<trip_id>.gpx`) as ground truth: GTFS-RT fix accuracy and staleness, real dwells vs the profile, live view and playback error |
| `npx tsx pipelines/eval-ais.ts [YYYYMMDD]` | Recorded SeaBus AIS against the timetable |
| `npx tsx pipelines/screenshot.ts out.png "<path>"` | Screenshot the running site with the local Chrome (`--mobile`, `--dark`, `--pick <route>`) |
