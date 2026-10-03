# Pipelines

Build-time data pipelines, validators and tools, run from the repo root (`npm run …` or `npx tsx pipelines/<name>.ts`). They write to `var/` (gitignored); `lib/paths.ts` is the one place that knows where data lives. The models they build are described in [packages/transit-core/DESIGN.md](../packages/transit-core/DESIGN.md). In production the server runs the build steps daily ([apps/server → Jobs](../apps/server/README.md#jobs)).

## Building the transit data

`npm run data` runs every step in order. The steps:

| Command | Script | What |
|---|---|---|
| `npm run data:gtfs` | `fetch-gtfs.ts`, `build-schedule.ts` | Fetch the latest TransLink GTFS (or `--history <date>` for a dated snapshot), archive it by feed version, build a service plan per feed and the manifest ([Timetables](../packages/transit-core/DESIGN.md#timetables)) |
| `npm run data:osm` | `fetch-osm.ts`, `import-osm.ts` | Fetch SkyTrain track from OSM (Overpass) and import it into `regions/metro-vancouver/infrastructure/*.generated.geojson` ([Track graph](../packages/transit-core/DESIGN.md#track-graph)) |
| `npm run build:infra` | `build-infra.ts` | Publish the track network and per-feed platform mapping |
| `npm run build:movements` | `build-movements.ts` | Infer runs and dispatch them, per service-day type (`--verbose`, `--no-dispatch`) ([Run inference](../packages/transit-core/DESIGN.md#run-inference), [Dispatcher](../packages/transit-core/DESIGN.md#dispatcher)) |
| `npm run build:observations` | `build-observations.ts` | Validate and publish observation files |
| `npm run build:dispatch` | `build-dispatch.ts` | Re-dispatch dates with observations or disruptions into per-date patches |
| `npm run build:rt-profile` | `build-rt-profile.ts` | Learn bus travel-time profiles from recorded history ([Buses](../packages/transit-core/DESIGN.md#buses)) |
| `npm run scenario -- <name>` | `scenario.ts` | Build a scenario ([Scenarios](../packages/transit-core/DESIGN.md#scenarios)) |
| `npm run tiles -- --region bc` | `tiles.ts` | The basemap: a BC extract of the Protomaps daily build (~2 GB), plus fonts and sprites |

After changing infrastructure, config or pipeline code, rebuild and run both validators.

## Validators

- `npm run validate:infra` (`validate-infra.ts`): the track graph against GTFS and the diagram checklist. Exits non-zero on failure.
- `npm run validate:plan` (`validate-plan.ts`): built movement files: teleports (fail), conflicts, dispatch delays, broken deadlocks and fleet peaks (report).

What they check is in [packages/transit-core/DESIGN.md → Validation](../packages/transit-core/DESIGN.md#validation). CI runs both against a pinned GTFS snapshot.

## Tools

| Command | What |
|---|---|
| `npm run disruptions` | Without a database: list, confirm or discard drafted disruptions (production uses `/admin`) |
| `npm run snapshot:pull -- --from <date> --to <date> [--db]` | Pull production recordings (and a database snapshot) into `var/` ([deployment/README.md → Snapshots](../deployment/README.md#snapshots-for-development)) |
| `npx tsx pipelines/eval-rt.ts` | Replay recorded RT data as the live view would: prediction error and jumps (`--subsample schedule` thins it to the poll schedule) |
| `npx tsx pipelines/probe-ais.ts` | Record raw aisstream.io messages for the SeaBus fleet and summarise them |
| `npx tsx pipelines/eval-ais.ts [YYYYMMDD]` | Recorded SeaBus AIS against the timetable |
| `npx tsx pipelines/trackside-replay.ts <video> [--roi x,y,w,h] [--bands t,b;t,b] [--ocr]` | A recorded clip through the trackside camera detector and reader ([packages/trackside](../packages/trackside/README.md#replaying-clips)) |
| `npx tsx pipelines/screenshot.ts out.png "<path>"` | Screenshot the running site with the local Chrome (`--mobile`, `--dark`, `--pick <route>`) |
