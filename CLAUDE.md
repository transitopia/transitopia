# CLAUDE.md

Guidance for working in this repo. The design is in [docs/DESIGN.md](docs/DESIGN.md) (architecture, principles, decisions), with each part's design next to its code: [apps/web](apps/web/README.md), [apps/server](apps/server/README.md), [packages/db](packages/db/README.md), the transit engine in [packages/transit-core/DESIGN.md](packages/transit-core/DESIGN.md) (track graph, run inference, dispatcher, buses, AIS), [packages/transit-map](packages/transit-map/README.md), [pipelines](pipelines/README.md) and [deployment](deployment/README.md). Read the relevant one before making structural changes. What we know about Metro Vancouver's operations is in [config/regions/metro-vancouver/README.md](config/regions/metro-vancouver/README.md), and the assumptions still open in its [OPEN-QUESTIONS.md](config/regions/metro-vancouver/OPEN-QUESTIONS.md); likewise for [Greater Victoria](config/regions/greater-victoria/README.md) and [Central Okanagan](config/regions/central-okanagan/README.md). Regions and the feeds they show: [docs/DESIGN.md → Regions and feeds](docs/DESIGN.md#regions-and-feeds). Planned work is in GitHub issues.

## Layout

npm workspaces ([docs/DESIGN.md → Repository layout](docs/DESIGN.md#repository-layout)). Cross-workspace imports use package specifiers (`@transitopia/transit-core/time.ts`); imports inside a workspace stay relative.

| Path | What |
|---|---|
| `apps/web/` | The transitopia.org SPA: React 19, Vite, Tailwind, wouter, MapLibre. `/transit` and `/cycling` share one map; the position is in `#map=z/lat/lng`, mode state in the query. |
| `apps/server/` | The server (api.transitopia.org): budgeted TransLink poller, AIS stream, recorder, live dispatch, scheduled jobs (statistics, retention, the daily data build), admin API. Hono; settings from the environment (`src/env.ts`). |
| `packages/db/` | PostgreSQL: SQL migrations, Kysely types (`schema.ts`), partitions, `job_runs`. Tests use a scratch database when `TEST_DATABASE_URL` is set. |
| `packages/transit-core/` | DOM-free engine: GTFS, track graph, run inference, dispatcher, playback, corrections, RT prediction. |
| `packages/transit-map/` | The transit engine on a host map: `TransitEngine.create(map, { dataBase, apiBase, theme, config })` (`engine.ts`; `config` is the region's, from the host); clock, playback, WebGL layers, and a snapshot store React reads with `useSyncExternalStore`. No UI framework. |
| `packages/map-style/` | The site's Protomaps basemap (light and dark), fonts list and zoom helpers. |
| `packages/shared/` | Shared by web and server: the dataset registry (`datasets.ts`) behind the attribution control. |
| `pipelines/` | Build-time pipelines and validators. |
| `packages/data/` | Node-side data access shared by pipelines and the server: `src/paths.ts` is the one place that knows where data lives; GTFS zips, disruption files, the track graph, dispatch contexts. Not for the browser. |
| `config/` | Committed, curated inputs, one package (`@transitopia/config`): `defaults/` (vehicles and real-time use everywhere), `server/` (the server's own: port, live dispatch, recording and statistics), `features/` (feature reconciliation), `operators/<id>/operator.json` (TransLink, BC Transit, with overrides), `feeds/<id>/` (`feed.json`: GTFS and GTFS-RT, request budget, AIS, its operator; `routes.json`: what's drawn), `regions/<id>/` (`region.json`, its settings files, and for Metro Vancouver `infrastructure/`, `scenarios/`, `observations/`, `disruptions/`; `README.md`, `OPEN-QUESTIONS.md`). Regions: `metro-vancouver`, `greater-victoria`, `central-okanagan`. |
| `map-layers/` | Java/Planetiler profile for the cycling layer (built daily in CI). |
| `infra/` | Deployment: `compose.yml` (server, PostGIS, Caddy, backups), `server.Dockerfile`, `compose.dev.yml` (the local database). See `deployment/README.md`. |
| `var/` | Gitignored downloads, recordings and build output. The web dev server serves `var/public/` at `/dev-data/`. |

## Scope

- **Transit routes**: Metro Vancouver: Expo, Millennium, and Canada Lines (track-level); SeaBus and West Coast Express (shape-level); buses 99, R1, R2, R3, R4, R5, R6, and the regular routes 5, 6, 9, 16, 19, 25 and 49 (the rest wait for the all-buses work, #194). Greater Victoria and Central Okanagan: every bus route (the 95 Blink and 97 Okanagan RapidBus as frequent). **No other Metro Vancouver bus routes drawn** until the all-buses work, though the recorder keeps every route and cards list every bus route in the feed (the plan's route catalogue, `packages/transit-core/DESIGN.md#route-catalogue`: names, stops served, frequency; no departure times or vehicles).
- **Transit stack**: TypeScript, Vite, and MapLibre GL JS v6 with a PMTiles vector basemap (Protomaps, `packages/map-style`). Vehicles are drawn by our own WebGL2 custom layer (`packages/transit-map/src/layers/gl-polygons.ts`) using only MapLibre's public API. Don't reintroduce deck.gl: its MapLibre integration depends on private internals that v6 removed. The engine stays framework-free; React is for the site's chrome. MIT licensed.
- Desktop-first, but the map and time controls must work on phones. Keep chrome minimal.

## Ground rules

- **Never print, log, commit, or bundle the API keys.** They live in `.secrets` (`TRANSLINK_API_KEY=...`, `AISSTREAM_API_KEY=...`, gitignored). Only `apps/server/` and `pipelines/` read them. Browser code must never see them.
- **Never let client requests trigger TransLink API calls.** A single poller per feed fetches upstream on a time-of-day schedule within the feed's daily cap: TransLink's 1,000 requests a day (`config/feeds/<feed>/feed.json` → `realtime.poll`, enforced by a ledger: the `upstream_requests` table, or `var/rt-history/<feed>/requests.json` without a database). Clients only read the cached snapshot. Don't add requests outside that budget, and don't assume fixes arrive every ~20 s: use the thresholds in `packages/transit-core/src/rt/budget.ts`. Only the leader polls, records, dispatches and runs jobs: a Postgres advisory lock (`apps/server/src/leader.ts`; the `var/rt-history/.lock` file without a database), and other instances forward `/rt/*` to it. **Only production polls** (the key's budget is shared): the server polls only with `RT_POLL=1`, keyless feeds (BC Transit) included; locally use `RT_FORWARD_TO=https://api.transitopia.org` or point the site at production (`VITE_TRANSIT_DATA=https://data.transitopia.org/ VITE_TRANSIT_API=https://api.transitopia.org/ npm run dev`: set both, since live positions also depend on published data such as the nightly `rt-profile.json`).
- **Dispatching is central.** The signalling-aware dispatcher (`packages/transit-core/DESIGN.md` → Dispatcher) runs only at build time and in the server, and every visitor gets the same versioned result. A patch only fits the build it was dispatched against (`baseBuiltAt`), which is why the server builds and publishes the transit data itself. Browsers never run it, and client requests never trigger a dispatch.
- **Positions are a pure function of (plan, overlays, t).** Don't introduce frame-stepped simulation state. Seek, rewind, and fast-forward depend on this.
- **Every vehicle state carries provenance** (`observed | interpolated | estimated`) and a source. Never render an estimate as if it were observed.
- **`packages/transit-core/src/` stays DOM-free.** It's shared by pipelines, tests, the server and the browser; its tsconfig has no DOM lib.
- **Infrastructure is data.** Base geometry is imported from OSM (`tracks.generated.geojson`, don't hand-edit it). Fixes go in `config/regions/metro-vancouver/infrastructure/overrides.json`. The result must pass `npm run validate:infra`.
- **Assumptions go in `config/regions/<region>/`** (or a feed's `feed.json`) with a comment citing the source or saying "guess", and a cross-reference to the matching item in that region's `OPEN-QUESTIONS.md` ("OPEN-QUESTIONS #N"; numbers are stable per region). When a question is answered, update the config and move the answer, with its source, to the region's `README.md`. No magic numbers in code. Each config file has a strict schema in `packages/transit-core/src/config.ts` (and `region.json`, `feed.json`): add a new setting there too, and load config with `parseConfig`/`parseRegion`/`parseFeed` (or `readConfig`/`readRegion`/`readFeed` in pipelines), never a cast.
- **Durable data references features by ID**, never by GTFS ids alone (they change between feed versions), and strings that name features take the two forms in `packages/shared/src/features.ts`: an ID (`sn-k3v9qd7m`, with an optional name suffix) or a ref (`gtfs-stop:translink:12034`). See `docs/DESIGN.md#feature-ids`.
- Select GTFS routes **by name** (`route_long_name` "Expo Line", `route_short_name` "099"/"R1"/"WCE"/"95", etc.), never by `route_id`. IDs change between feeds.
- **Per feed, per region.** What comes from a feed (plans, recordings, raw data, AIS, statistics) is keyed by the feed id; what belongs to a place (tracks, corrections, dispatch, scenarios) by the region. Settings resolve in layers: `config/defaults/`, the feed's operator, the feed, its routes (vehicles) or the region (`rt.json`: place-specific settings only) (`readFeedConfig`). Track-level rail runs on rail networks (`railNetworks()`; the server's dispatcher and corrections take the one `railNetwork()`). Service dates are `ServiceDate` (branded "YYYYMMDD"; `serviceDate()` where they enter). Agency quirks go behind adapters; keep GTFS handling generic.
- Timetables: support the current feed and every future feed. Pick the feed for a date via the manifest (newest feed covering that date).

## Track model notes

- Segments are OSM ways split at junctions (`w<wayId>.<n>`). Turns are derived from geometry (≤35° deviation passes straight through), so no per-switch tagging is needed; fix mistakes with `turns` in `overrides.json`.
- Platform mapping (`packages/transit-core/src/infra/platforms.ts`) is a global optimisation, not a nearest-track snap: route consistency + distinct tracks per numbered platform (except terminal arrival/departure berths) + every trip end must turn back or pull in to a yard. Debug it with `?debug=1` (segment ids, platform markers) and `npm run validate:infra`.
- SeaBus geometry is data too: berths and keep-right lanes in `config/regions/metro-vancouver/infrastructure/seabus.json`, the default berth pair in `config/regions/metro-vancouver/seabus.json` (AIS overrides it per day). `build-schedule` swaps them in for the GTFS shapes (`packages/transit-core/src/plan/ferry-berths.ts`), keeping pattern ids unchanged because movement files reference them. `build-schedule` rebuilds the plans when either file changes.
- Track with a future `opening_date` (e.g. the Broadway Extension) goes to `future.generated.geojson` for scenarios, not the base network.
- `overrides.json` also supports `addTrack` (GeoJSON track missing from OSM) and `patternPlatforms` (role-based pins for trips that terminate at vs pass through a station, for temporary operations such as the OMC4 works at Braid). Verify any added infrastructure on imagery before relying on it.

## Run inference notes (`packages/transit-core/src/movement/build.ts`)

- Trip times: SkyTrain/WCE/SeaBus trips are re-timed within ±45 s of GTFS (minute-rounded) in proportion to each hop's physical minimum time (`retime` in `schedule/engine.ts`). Without this, some hops are impossibly fast.
- Chaining: GTFS block successor first (only when it starts where the last trip ended and no earlier departure from that platform track is still unserved), else FIFO earliest feasible departure. Turnbacks choose between the GTFS departure platform (via tail/pocket/main reversals) and reversing in place, by cost.
- In-place turnbacks get stub berths by occupancy (`berth`/`arrive` overrides on trip events), pulled up to the buffer.
- Surplus trains at stub termini (would wait > `turnback.stubMaxLayoverS`, or every dead-ended berth is taken) pull in to the yard instead of queueing. Timing pull-ins into gaps between scheduled trains was tried and made no measurable difference, so it isn't implemented.
- Pull-outs/pull-ins avoid running against the normal direction of traffic (`yard.againstTrafficPenalty`); turnbacks have their own speed (`turnback.speedFactor`).
- Playback (`playback.ts`) is pure: (movement file, prepared plan, graph, t) → positions. Keep it that way.
- Debug with `npm run build:movements -- --verbose` (per-terminus chaining stats) and `npm run validate:plan` (conflict hot spots).

## Dispatcher notes (`packages/transit-core/src/dispatch/`, `packages/transit-core/DESIGN.md` → Dispatcher)

- `build:movements` runs inferred runs through the signalling simulation (moving block, junction locks, sections for track used both ways, stub berths). Its output is still a movement file; playback stays pure. `--no-dispatch` writes the timetable-only plan for comparison.
- Deadlocks are prevented by resource order (see `packages/transit-core/DESIGN.md` → Dispatcher, "Resource order"), not by the breaker. A "deadlock broken" line in `validate:plan` is a bug to look at: `DISPATCH_DEBUG=1` prints the waits-for chain, `DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>` traces one train.

## Corrections

- Observations (`packages/transit-core/src/corrections/`) reference **service date + GTFS trip_id** or **stop + time**, never inferred run ids.
- **Where corrections live:** in production, the database (`observation_sets`, `disruptions`) with review states `draft → previewing → confirmed | discarded`, reviewed at `/admin` (`docs/DESIGN.md` → Corrections and previews): a preview is a dispatch version only its link shows (`/transit?preview=<YYYYMMDD>:<version>`). The files under `config/regions/metro-vancouver/{observations,disruptions}` are imported on a new database and are what local runs without a database use; `npm run corrections -- export|import|pull` moves them between the two.
- SkyTrain: `railInputs()` turns them into dispatcher anchors (a stop at a time), cancellations, consists and parked trains. The dispatcher re-dispatches the date centrally (`build:dispatch` → `var/public/data/regions/metro-vancouver/dispatch/<date>.json`, a patch of the runs that changed); playback marks positions observed within 90 s of a sighting and interpolated where times moved. Browsers never reconcile rail observations.
- Timetable vehicles (SeaBus, WCE, buses without RT): `reconcileScheduled()` in the app, as before.
- Disruptions (format in `config/regions/metro-vancouver/disruptions/README.md`): single-track sections and reduced headways for a period. `build:dispatch` re-plans each affected date (`packages/transit-core/src/disruption/apply.ts` → re-inferred runs with closures → dispatch). Only confirmed entries apply. The server drafts them from TransLink alerts (into the database, or `config/regions/metro-vancouver/disruptions/drafts/` without one); never confirm a draft without knowing which track stays open (`/admin` refuses to).
- A future rail real-time adapter should emit `Observation`s rather than touch playback.
- **Every route is recorded** (hour files and `rt_positions`), not just the ones drawn: vehicles on other routes get an untracked route key (`gtfs:<route_id>`), and every reader keeps only tracked ones (`trackedOnly` in `packages/transit-core/src/rt/types.ts`; `/rt/history` filters). Raw data expires after 60 days (`config/server/recording.json`); before that, the nightly job derives observed stop times and per-route statistics (`packages/transit-core/src/rt/observed.ts`, `stats.ts`), kept indefinitely. Recompute a date with `npm run stats -- <YYYYMMDD>`.
- Bus service changes from GTFS-RT (cancelled trips, skipped stops, detour alerts) are recorded per service date in `var/rt-history/<feed>/changes/` and served at `/regions/<id>/days/<date>/translink/changes` (the live endpoint points to the current version). `packages/transit-core/src/rt/changes.ts` explains them; see `packages/transit-core/DESIGN.md` → Buses. TransLink sends detours only as alert text, so they aren't drawn.
- SeaBus AIS (`packages/transit-core/DESIGN.md` → SeaBus AIS): the RT leader streams aisstream.io and records to `var/ais-history/<feed>/` (vessels in `config/feeds/translink/feed.json` → `ais`); the browser turns fixes into `ScheduleCorrections` with `aisCorrections()` (`packages/transit-core/src/ais/match.ts`). Fixes anchor the timetable rather than being drawn raw, because they arrive in bursts.

## Scenarios

- `packages/transit-core/src/infra/network.ts` builds topology for both the OSM import and scenarios. `composeNetwork` rebuilds base + future + custom track by shared coordinates. Keep them on the same code path.
- Service operations live in `packages/transit-core/src/scenario/service.ts` and must not mutate the base plan (it's `structuredClone`d).
- Scenario outputs go to `var/public/data/regions/metro-vancouver/scenarios/<name>/` (gitignored). Only the spec and custom geometry are committed.

## GTFS gotchas (verified against feed 26SEP_20260925)

- Times can exceed 24:00 and have a leading space: `" 5:05:00"`, `"25:30:00"`. Store as seconds since service-day start.
- Service days come from `calendar.txt` **and** `calendar_dates.txt`. `1` = weekday, `2` = Sat, `3` = Sun/holiday, plus supplementary IDs added by date (e.g. `1101` on Mon–Thu only). Holidays remove `1`.
- Rail `stop_times` reference **platform** stops (`"Waterfront Station @ Platform 2"`). Parents are `999xx` (Capstan = `99959`). Some Canada Line termini use `"… Station @ Canada Line"` with no platform number.
- Rail arrival equals departure (no dwell in the data). Dwell comes from config.
- `block_id` is **not** a physical train (Expo has ~133 weekday blocks). It's a hint only.
- `shape_dist_traveled` is in km.
- The undated `https://gtfs-static.translink.ca/gtfs/google_transit.zip` is the latest feed. Read `feed_info.txt` for the version and validity range.
- GTFS-RT (`https://gtfsapi.translink.ca/v3/{gtfsrealtime,gtfsposition,gtfsalerts}?apikey=…`) covers buses only (no SkyTrain, SeaBus, or WCE) and sends no CORS headers. Trip updates drop a trip once it has run, cancelled or not (seen 2026-09-29).

## Commands

Run from the repo root.

```sh
npm run dev              # the site (apps/web) at http://localhost:5173: /transit, /cycling
npm run server           # the server on :8787 (schedule-only; RT_FORWARD_TO=https://api.transitopia.org for live data); run the site with VITE_TRANSIT_API=http://localhost:8787/ to use it
npm run db:up            # the local PostgreSQL (infra/compose.dev.yml); then DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/transitopia npm run server
npm run db:import-history # var/{rt,ais,dispatch}-history → the database (idempotent)
npm run stats -- 20260928 # observed stop times + route statistics for a service date (needs DATABASE_URL)
npm run corrections -- export <dir> | import [<dir>] | pull   # corrections between the database and files
npm run features -- pull | places | reconcile | show <key> | move <stop> <place> | detach <stop>… | retire <key>…   # the feature registry (pull: production's IDs, wipes the local registry)
npm run snapshot:pull -- --from 2026-09-20 --to 2026-09-27 [--db]   # production recordings (+ DB snapshot) into var/ (needs rclone access to the archive)
npm test                 # vitest, every workspace (database tests need TEST_DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/postgres)
npm run typecheck        # tsc in every workspace
npm run lint             # oxlint --type-aware, repo-wide; warnings fail it (and CI)
npm run format           # prettier (format-check in CI)
npm run build            # build every workspace that has a build
npm run data:gtfs        # fetch every feed's latest GTFS + build plans and manifests [-- --feed <id>]
npm run data             # fetch-gtfs, fetch-osm, import-osm, build-schedule, build-infra, build-movements, …
npm run tiles -- --region bc # the site's basemap, var/public/tiles/protomaps-bc.pmtiles (~2 GB) + fonts/sprites
npm run data:osm         # fetch OSM tracks + import → config/regions/<rail region>/infrastructure/*.generated.geojson
npm run data:roads       # fetch OSM roads per feed → var/raw/osm-roads/<feed>/ (build-schedule then matches bus shapes and builds corridors)
npm run build:infra      # publish tracks + per-feed platform mapping to var/public/data
npm run validate:infra   # graph / platform / routing / turnback / checklist checks
npm run build:movements  # infer + dispatch train runs → var/public/data/feeds/translink/<v>/movements/*.json [--verbose] [--no-dispatch]
npm run validate:plan    # teleports (fail), conflicts, dispatch delays and broken deadlocks (report), fleet peaks
npm run build:observations # validate + publish config/regions/metro-vancouver/observations/*.json (format in its README)
npm run build:dispatch   # re-dispatch dates with observations or disruptions → var/public/data/regions/metro-vancouver/dispatch/<date>.json + index.json
npm run disruptions      # without a database: list/confirm/discard drafted disruptions [-- pull | confirm <id> [--keep "<stop>"] | discard <id>] (production: /admin)
npm run build:rt-profile # learn bus travel-time profiles from var/rt-history/<feed> → var/public/data/feeds/<feed>/<v>/rt-profile.json [-- --feed <id>]
npm run scenario -- <name> # build config/regions/metro-vancouver/scenarios/<name>/ → view at /?scenario=<name> (see its README)
npx tsx pipelines/eval-rt.ts [--test-last 3] [--set key=value] # replay recorded RT: prediction error and live-view jumps, old vs new
npx tsx pipelines/probe-ais.ts [--minutes 30] # record raw aisstream.io messages for the SeaBus fleet and summarise them
npx tsx pipelines/eval-gpx.ts [<file.gpx>]    # GPX ridden on a bus vs recorded RT, the profile and the live view (ground truth)
npx tsx pipelines/eval-ais.ts [YYYYMMDD]      # recorded SeaBus AIS vs the timetable: matches, lateness, vessels per block, berths
npx tsx pipelines/screenshot.ts out.png "/transit?date=2026-09-28&t=08:00:00&paused=1#map=14/49.28/-123.11" [--mobile] [--dark] [--pick expo]
```

## Workflow

- Formatting is prettier (config at the root) and linting is oxlint (`.oxlintrc.json`); a warning fails `npm run lint`, so fix it or, for a real false positive, disable the rule on that line with a comment saying why. Markdown, `regions/` data, `var/` and `map-layers/` aren't prettier-formatted (`.prettierignore`).
- CI (`.github/workflows/checks.yml`) runs lint, format-check, typecheck, tests and builds, and both validators against a pinned GTFS snapshot (`FIXTURE_FEED_DATE`).
- Time zones come from the runtime's tzdata (via ICU), never hard-coded. BC moved to permanent UTC−7 in 2026 (tzdata 2026b), so older data gets every time after 2026-11-01 wrong by an hour: the time tests fail and the server refuses to start (`timezoneChecks` in `config/regions/metro-vancouver/region.json`). Homebrew's `node` uses Homebrew's icu4c, whose tzdata can lag Node's own builds: use an official Node build, or set `ICU_TIMEZONE_FILES_DIR` to a folder with current `.res` files from https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew/<version>/44/le.
- Everything under `var/` is gitignored: `var/raw/gtfs/<feed>/`, `var/rt-history/<feed>/`, `var/ais-history/<feed>/`, `var/dispatch-history/`, `var/public/{data,tiles,basemap-assets}/`. Published data: `data/feeds/<feed>/` (manifest, plans, movements, profiles) and `data/regions/<region>/` (tracks, observations, dispatch, scenarios).
- Browser-facing URLs (`/data/…`, `/tiles/…`) are paths under `var/public/`, not repo paths: published indexes store them as `data/…`.
- Database changes: add `packages/db/migrations/NNN_<name>.sql` (never edit one that's deployed) and the matching types in `packages/db/src/schema.ts`. The server applies migrations when it starts. Raw per-poll tables are partitioned by day; `Store` creates a missing partition on demand.
- Where the site reads its data: `apps/web/src/config.ts` (local defaults: `var/public` via `/dev-data/`) and `apps/web/.env.production`. Without `VITE_TRANSIT_API` the engine makes no RT requests at all (schedules only).
- Every map overlay re-adds its layers after a theme switch: depend on `useStyleGeneration()` (cycling) or call `engine.setTheme()` before the style swaps (transit). Declare what a mode draws with `useDatasets([...])` so the attribution control credits it.
- TypeScript is strict repo-wide (`tsconfig.base.json`: `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, no unused locals): write optional properties as `x?: T | undefined` when `undefined` is passed explicitly, and no constructor parameter properties (Node's type stripping rejects them).
- Route colours, names and categories are baked into `plan.json` from the feed's `config/feeds/<feed>/routes.json`. `build-schedule` rebuilds a plan when that file (or another config it reads) changes, or when its `PLAN_FORMAT` is bumped: bump it whenever the script writes something different from the same feed and config.
- After changing infrastructure, config, or pipeline code, rebuild and run both validators before calling the work done.
- For visual changes, run the app and look at it (`pipelines/screenshot.ts` drives the local Chrome; `window.transit` is a debug handle on /transit with `map`, `clock`, `store`, `rt`, `vehicles()`), especially at station zoom around Waterfront, Columbia/Sapperton, Commercial–Broadway, Lougheed, Edmonds (OMC 1), and Bridgeport, where the track work is densest. Check the phone layout too.
- Prefer small, reviewable commits per milestone step.
- Docs describe what's built: update the design doc next to the code you change (and `docs/DESIGN.md` → Decisions when a decision changes). Planned work, follow-ups and known limitations go in GitHub issues, not in docs or TODO comments. Code comments cite docs by path and section, e.g. `packages/transit-core/DESIGN.md#dispatcher`.
- Branches: work on feature branches forked from `main`; production (site and server) deploys from `prod` when `main` is merged into it and pushed (`deployment/README.md` → Branches).
- Preview builds: a few minutes after a branch is pushed, Cloudflare Pages serves its frontend at `https://<branch>.transitopia-web.pages.dev` (e.g. https://ux-overhaul.transitopia-web.pages.dev). Only the site is built: there's no test backend, so a preview reads production's published data and API (`apps/web/.env.production`), and server-side changes on the branch aren't in effect.
