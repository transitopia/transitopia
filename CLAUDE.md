# CLAUDE.md

Guidance for working in this repo. Transitopia V2 is being built to [V2-PLAN.md](V2-PLAN.md): read it before making structural changes, and update it when a decision changes. The transit engine's design (track graph, run inference, dispatcher, RT, AIS) is in [docs/skytrain-viz-PLAN.md](docs/skytrain-viz-PLAN.md), and operations assumptions are tracked in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

## Layout

npm workspaces (V2-PLAN.md §4.1). Cross-workspace imports use package specifiers (`@transitopia/transit-core/time.ts`); imports inside a workspace stay relative.

| Path | What |
|---|---|
| `apps/web/` | The transitopia.org SPA: React 19, Vite, Tailwind, wouter, MapLibre. `/transit` and `/cycling` share one map; the position is in `#map=z/lat/lng`, mode state in the query. |
| `apps/server/` | RT service: budgeted TransLink poller, AIS stream, recorder, live dispatch. Becomes the V2 server (Phase 2). |
| `packages/transit-core/` | DOM-free engine: GTFS, track graph, run inference, dispatcher, playback, corrections, RT prediction. |
| `packages/transit-map/` | The transit engine on a host map: `TransitEngine.create(map, { dataBase, apiBase, theme })` (`engine.ts`); clock, playback, WebGL layers, and a snapshot store React reads with `useSyncExternalStore`. No UI framework. |
| `packages/map-style/` | The site's Protomaps basemap (light and dark), fonts list and zoom helpers. |
| `packages/shared/` | Shared by web and server: the dataset registry (`datasets.ts`) behind the attribution control. |
| `pipelines/` | Build-time pipelines and validators. `pipelines/lib/paths.ts` is the one place that knows where data lives. |
| `regions/metro-vancouver/` | Committed, curated inputs: `config/`, `infrastructure/`, `scenarios/`, `observations/`, `disruptions/`. |
| `map-layers/` | Java/Planetiler profile for the cycling layer (built daily in CI). |
| `var/` | Gitignored downloads, recordings and build output. The web dev server serves `var/public/` at `/dev-data/`. |

## Scope

- **Transit routes**: Expo, Millennium, and Canada Lines (track-level); SeaBus and West Coast Express (shape-level); buses 99, R1, R2, R3, R4, R5, R6. **No other bus routes** until Phase 7 (V2-PLAN.md §9), though the recorder keeps every route.
- **Transit stack**: TypeScript, Vite, and MapLibre GL JS v6 with a PMTiles vector basemap (Protomaps, `packages/map-style`). Vehicles are drawn by our own WebGL2 custom layer (`packages/transit-map/src/layers/gl-polygons.ts`) using only MapLibre's public API. Don't reintroduce deck.gl: its MapLibre integration depends on private internals that v6 removed. The engine stays framework-free; React is for the site's chrome (V2-PLAN.md §4.2). MIT licensed.
- Desktop-first, but the map and time controls must work on phones. Keep chrome minimal.

## Ground rules

- **Never print, log, commit, or bundle the API keys.** They live in `.secrets` (`TRANSLINK_API_KEY=...`, `AISSTREAM_API_KEY=...`, gitignored). Only `apps/server/` and `pipelines/` read them. Browser code must never see them.
- **Never let client requests trigger TransLink API calls.** A single poller fetches upstream on a time-of-day schedule that stays under TransLink's 1,000 requests a day (`regions/metro-vancouver/config/rt.json` → `poll`, enforced by a ledger in `var/rt-history/requests.json`). Clients only read the cached snapshot. Don't add requests outside that budget, and don't assume fixes arrive every ~20 s: use the thresholds in `packages/transit-core/src/rt/budget.ts`. Only one process per machine polls and records: the leader holds `var/rt-history/.lock` ({pid, port}), and any other RT service instance forwards `/rt/*` to it. The lock is per checkout, so two checkouts with keys would both poll and double the spend: development machines don't poll (V2-PLAN.md §7.5), and without `.secrets` the RT service runs schedule-only.
- **Dispatching is central.** The signalling-aware dispatcher (docs/skytrain-viz-PLAN.md §4.11) runs only at build time and in the RT service, and every visitor gets the same versioned result. Browsers never run it, and client requests never trigger a dispatch.
- **Positions are a pure function of (plan, overlays, t).** Don't introduce frame-stepped simulation state. Seek, rewind, and fast-forward depend on this.
- **Every vehicle state carries provenance** (`observed | interpolated | estimated`) and a source. Never render an estimate as if it were observed.
- **`packages/transit-core/src/` stays DOM-free.** It's shared by pipelines, tests, the server and the browser; its tsconfig has no DOM lib.
- **Infrastructure is data.** Base geometry is imported from OSM (`tracks.generated.geojson`, don't hand-edit it). Fixes go in `regions/metro-vancouver/infrastructure/overrides.json`. The result must pass `npm run validate:infra`.
- **Assumptions go in `regions/metro-vancouver/config/`** with a comment citing the source or saying "guess", and a cross-reference to the matching item in `docs/OPEN-QUESTIONS.md`. No magic numbers in code.
- Select GTFS routes **by name** (`route_long_name` "Expo Line", `route_short_name` "099"/"R1"/"WCE", etc.), never by `route_id`. IDs change between feeds.
- Timetables: support the current feed and every future feed. Pick the feed for a date via the manifest (newest feed covering that date).

## Track model notes

- Segments are OSM ways split at junctions (`w<wayId>.<n>`). Turns are derived from geometry (≤35° deviation passes straight through), so no per-switch tagging is needed; fix mistakes with `turns` in `overrides.json`.
- Platform mapping (`packages/transit-core/src/infra/platforms.ts`) is a global optimisation, not a nearest-track snap: route consistency + distinct tracks per numbered platform (except terminal arrival/departure berths) + every trip end must turn back or pull in to a yard. Debug it with `?debug=1` (segment ids, platform markers) and `npm run validate:infra`.
- SeaBus geometry is data too: berths and keep-right lanes in `regions/metro-vancouver/infrastructure/seabus.json`, the default berth pair in `regions/metro-vancouver/config/seabus.json` (AIS overrides it per day). `build-schedule` swaps them in for the GTFS shapes (`packages/transit-core/src/plan/ferry-berths.ts`), keeping pattern ids unchanged because movement files reference them. Rebuild with `npx tsx pipelines/build-schedule.ts --force`.
- Track with a future `opening_date` (e.g. the Broadway Extension) goes to `future.generated.geojson` for scenarios, not the base network.
- `overrides.json` also supports `addTrack` (GeoJSON track missing from OSM) and `patternPlatforms` (role-based pins for trips that terminate at vs pass through a station, for temporary operations such as the OMC4 works at Braid). Verify any added infrastructure on imagery before relying on it.

## Run inference notes (`packages/transit-core/src/movement/build.ts`)

- Trip times: SkyTrain/WCE/SeaBus trips are re-timed within ±45 s of GTFS (minute-rounded) in proportion to each hop's physical minimum time (`retime` in `schedule/engine.ts`). Without this, some hops are impossibly fast.
- Chaining: GTFS block successor first (only when it starts where the last trip ended), else FIFO earliest feasible departure. Turnbacks choose between the GTFS departure platform (via tail/pocket/main reversals) and reversing in place, by cost.
- In-place turnbacks get stub berths by occupancy (`berth`/`arrive` overrides on trip events), pulled up to the buffer.
- Surplus trains at stub termini (would wait > `turnback.stubMaxLayoverS`, or every dead-ended berth is taken) pull in to the yard instead of queueing. Timing pull-ins into gaps between scheduled trains was tried and made no measurable difference, so it isn't implemented.
- Pull-outs/pull-ins avoid running against the normal direction of traffic (`yard.againstTrafficPenalty`); turnbacks have their own speed (`turnback.speedFactor`).
- Playback (`playback.ts`) is pure: (movement file, prepared plan, graph, t) → positions. Keep it that way.
- Debug with `npm run build:movements -- --verbose` (per-terminus chaining stats) and `npm run validate:plan` (conflict hot spots).

## Dispatcher notes (`packages/transit-core/src/dispatch/`, docs/skytrain-viz-PLAN.md §4.11)

- `build:movements` runs inferred runs through the signalling simulation (moving block, junction locks, sections for track used both ways, stub berths). Its output is still a movement file; playback stays pure. `--no-dispatch` writes the timetable-only plan for comparison.
- Deadlocks are prevented by resource order (see docs/skytrain-viz-PLAN.md §4.11 "As built"), not by the breaker. A "deadlock broken" line in `validate:plan` is a bug to look at: `DISPATCH_DEBUG=1` prints the waits-for chain, `DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>` traces one train.

## Corrections

- Observations (`packages/transit-core/src/corrections/`) reference **service date + GTFS trip_id** or **stop + time**, never inferred run ids.
- SkyTrain: `railInputs()` turns them into dispatcher anchors (a stop at a time), cancellations, consists and parked trains. The dispatcher re-dispatches the date centrally (`build:dispatch` → `var/public/data/dispatch/<date>.json`, a patch of the runs that changed); playback marks positions observed within 90 s of a sighting and interpolated where times moved. Browsers never reconcile rail observations.
- Timetable vehicles (SeaBus, WCE, buses without RT): `reconcileScheduled()` in the app, as before.
- Disruptions (`regions/metro-vancouver/disruptions/*.json`, format in its README): single-track sections and reduced headways for a period. `build:dispatch` re-plans each affected date (`packages/transit-core/src/disruption/apply.ts` → re-inferred runs with closures → dispatch). Only `"status": "confirmed"` entries apply. The RT service drafts them from TransLink alerts into `regions/metro-vancouver/disruptions/drafts/` (gitignored); never confirm a draft without knowing which track stays open.
- A future rail real-time adapter should emit `Observation`s rather than touch playback.
- Bus service changes from GTFS-RT (cancelled trips, skipped stops, detour alerts) are recorded per service date in `var/rt-history/changes/` and served at `/rt/changes`. `packages/transit-core/src/rt/changes.ts` explains them; see docs/skytrain-viz-PLAN.md §4.5. TransLink sends detours only as alert text, so they aren't drawn.
- SeaBus AIS (docs/skytrain-viz-PLAN.md §4.12): the RT leader streams aisstream.io and records to `var/ais-history/`; the browser turns fixes into `ScheduleCorrections` with `aisCorrections()` (`packages/transit-core/src/ais/match.ts`). Fixes anchor the timetable rather than being drawn raw, because they arrive in bursts.

## Scenarios

- `packages/transit-core/src/infra/network.ts` builds topology for both the OSM import and scenarios. `composeNetwork` rebuilds base + future + custom track by shared coordinates. Keep them on the same code path.
- Service operations live in `packages/transit-core/src/scenario/service.ts` and must not mutate the base plan (it's `structuredClone`d).
- Scenario outputs go to `var/public/data/scenarios/<name>/` (gitignored). Only the spec and custom geometry are committed.

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
npm run server           # RT service on :8787; run the site with VITE_TRANSIT_API=http://localhost:8787/ to use it
npm test                 # vitest, every workspace
npm run typecheck        # tsc in every workspace
npm run lint             # oxlint --type-aware, repo-wide
npm run format           # prettier (format-check in CI)
npm run build            # build every workspace that has a build
npm run data:gtfs        # fetch latest GTFS + build plan.json and manifest
npm run data             # fetch-gtfs, fetch-osm, import-osm, build-schedule, build-infra, build-movements, …
npm run tiles -- --region bc # the site's basemap, var/public/tiles/protomaps-bc.pmtiles (~2 GB) + fonts/sprites
npm run data:osm         # fetch OSM tracks + import → regions/metro-vancouver/infrastructure/*.generated.geojson
npm run build:infra      # publish tracks + per-feed platform mapping to var/public/data
npm run validate:infra   # graph / platform / routing / turnback / checklist checks
npm run build:movements  # infer + dispatch train runs → var/public/data/feeds/<v>/movements/*.json [--verbose] [--no-dispatch]
npm run validate:plan    # teleports (fail), conflicts, dispatch delays and broken deadlocks (report), fleet peaks
npm run build:observations # validate + publish regions/metro-vancouver/observations/*.json (format in its README)
npm run build:dispatch   # re-dispatch dates with observations or disruptions → var/public/data/dispatch/<date>.json + index.json
npm run disruptions      # list/confirm/discard disruptions drafted from TransLink alerts [-- pull | confirm <id> [--keep "<stop>"] | discard <id>]
npm run build:rt-profile # learn bus travel-time profiles from var/rt-history → var/public/data/feeds/<v>/rt-profile.json
npm run scenario -- <name> # build regions/metro-vancouver/scenarios/<name>/ → view at /?scenario=<name> (see its README)
npx tsx pipelines/eval-rt.ts [--test-last 3] [--set key=value] # replay recorded RT: prediction error and live-view jumps, old vs new
npx tsx pipelines/probe-ais.ts [--minutes 30] # record raw aisstream.io messages for the SeaBus fleet and summarise them
npx tsx pipelines/eval-ais.ts [YYYYMMDD]      # recorded SeaBus AIS vs the timetable: matches, lateness, vessels per block, berths
npx tsx pipelines/screenshot.ts out.png "/transit?date=2026-09-28&t=08:00:00&paused=1#map=14/49.28/-123.11" [--mobile] [--dark] [--pick expo]
```

## Workflow

- Formatting is prettier (config at the root) and linting is oxlint. Markdown, `regions/` data, `var/` and `map-layers/` aren't prettier-formatted (`.prettierignore`).
- CI (`.github/workflows/checks.yml`) runs lint, format-check, typecheck, tests and builds, and both validators against a pinned GTFS snapshot (`FIXTURE_FEED_DATE`).
- Everything under `var/` is gitignored: `var/raw/`, `var/rt-history/`, `var/ais-history/`, `var/dispatch-history/`, `var/public/{data,tiles,basemap-assets}/`.
- Browser-facing URLs (`/data/…`, `/tiles/…`) are paths under `var/public/`, not repo paths: published indexes store them as `data/…`.
- Where the site reads its data: `apps/web/src/config.ts` (local defaults: `var/public` via `/dev-data/`) and `apps/web/.env.production`. Without `VITE_TRANSIT_API` the engine makes no RT requests at all (schedules only).
- Every map overlay re-adds its layers after a theme switch: depend on `useStyleGeneration()` (cycling) or call `engine.setTheme()` before the style swaps (transit). Declare what a mode draws with `useDatasets([...])` so the attribution control credits it.
- TypeScript is strict repo-wide (`tsconfig.base.json`: `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, no unused locals): write optional properties as `x?: T | undefined` when `undefined` is passed explicitly, and no constructor parameter properties (Node's type stripping rejects them).
- Route colours and names are baked into `plan.json` from `regions/metro-vancouver/config/routes.json`; rebuild with `npx tsx pipelines/build-schedule.ts --force` after editing it.
- After changing infrastructure, config, or pipeline code, rebuild and run both validators before calling the work done.
- For visual changes, run the app and look at it (`pipelines/screenshot.ts` drives the local Chrome; `window.transit` is a debug handle on /transit with `map`, `clock`, `store`, `rt`, `vehicles()`), especially at station zoom around Waterfront, Columbia/Sapperton, Commercial–Broadway, Lougheed, Edmonds (OMC 1), and Bridgeport, where the track work is densest. Check the phone layout too.
- Prefer small, reviewable commits per milestone step.
