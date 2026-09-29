# CLAUDE.md

Guidance for working in this repo. The design lives in [PLAN.md](PLAN.md). Read it before making structural changes, and update it when a decision changes. Operations assumptions are tracked in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

## Scope

- **Routes**: Expo, Millennium, and Canada Lines (track-level); SeaBus and West Coast Express (shape-level); buses 99, R1, R2, R3, R4, R5, R6. **No other bus routes.**
- **Stack**: TypeScript, Vite, and MapLibre GL JS v6 with a PMTiles vector basemap (Protomaps). Vehicles are drawn by our own WebGL2 custom layer (`src/app/layers/gl-polygons.ts`) using only MapLibre's public API. Don't reintroduce deck.gl: its MapLibre integration depends on private internals that v6 removed. Plain TS with no UI framework. MIT licensed.
- Desktop-first, but the map and time controls must work on phones. Keep chrome minimal.

## Ground rules

- **Never print, log, commit, or bundle the API keys.** They live in `.secrets` (`TRANSLINK_API_KEY=...`, `AISSTREAM_API_KEY=...`, gitignored). Only `server/` (and later `worker/`) and scripts read them. Browser code must never see them.
- **Never let client requests trigger TransLink API calls.** A single poller fetches upstream on a fixed interval. Clients only read the cached snapshot. Only one process per machine polls and records: the leader holds `data/rt-history/.lock` ({pid, port}), and any other RT service instance forwards `/rt/*` to it.
- **Dispatching is central.** The signalling-aware dispatcher (PLAN.md §4.11) runs only at build time and in the RT service, and every visitor gets the same versioned result. Browsers never run it, and client requests never trigger a dispatch.
- **Positions are a pure function of (plan, overlays, t).** Don't introduce frame-stepped simulation state. Seek, rewind, and fast-forward depend on this.
- **Every vehicle state carries provenance** (`observed | interpolated | estimated`) and a source. Never render an estimate as if it were observed.
- **`src/core/` stays DOM-free.** It's shared by build scripts, tests, and workers.
- **Infrastructure is data.** Base geometry is imported from OSM (`tracks.generated.geojson`, don't hand-edit it). Fixes go in `data/infrastructure/overrides.json`. The result must pass `npm run validate:infra`.
- **Assumptions go in `data/config/`** with a comment citing the source or saying "guess", and a cross-reference to the matching item in `docs/OPEN-QUESTIONS.md`. No magic numbers in code.
- Select GTFS routes **by name** (`route_long_name` "Expo Line", `route_short_name` "099"/"R1"/"WCE", etc.), never by `route_id`. IDs change between feeds.
- Timetables: support the current feed and every future feed. Pick the feed for a date via the manifest (newest feed covering that date).

## Track model notes

- Segments are OSM ways split at junctions (`w<wayId>.<n>`). Turns are derived from geometry (≤35° deviation passes straight through), so no per-switch tagging is needed; fix mistakes with `turns` in `overrides.json`.
- Platform mapping (`src/core/infra/platforms.ts`) is a global optimisation, not a nearest-track snap: route consistency + distinct tracks per numbered platform (except terminal arrival/departure berths) + every trip end must turn back or pull in to a yard. Debug it with `?debug=1` (segment ids, platform markers) and `npm run validate:infra`.
- SeaBus geometry is data too: berths and keep-right lanes in `data/infrastructure/seabus.json`, the berth pair in use in `data/config/seabus.json`. `build-schedule` swaps them in for the GTFS shapes (`src/core/plan/ferry-berths.ts`), keeping pattern ids unchanged because movement files reference them. Rebuild with `npx tsx scripts/build-schedule.ts --force`.
- Track with a future `opening_date` (e.g. the Broadway Extension) goes to `future.generated.geojson` for scenarios, not the base network.
- `overrides.json` also supports `addTrack` (GeoJSON track missing from OSM) and `patternPlatforms` (role-based pins for trips that terminate at vs pass through a station, for temporary operations such as the OMC4 works at Braid). Verify any added infrastructure on imagery before relying on it.

## Run inference notes (`src/core/movement/build.ts`)

- Trip times: SkyTrain/WCE/SeaBus trips are re-timed within ±45 s of GTFS (minute-rounded) in proportion to each hop's physical minimum time (`retime` in `schedule/engine.ts`). Without this, some hops are impossibly fast.
- Chaining: GTFS block successor first (only when it starts where the last trip ended), else FIFO earliest feasible departure. Turnbacks choose between the GTFS departure platform (via tail/pocket/main reversals) and reversing in place, by cost.
- In-place turnbacks get stub berths by occupancy (`berth`/`arrive` overrides on trip events), pulled up to the buffer.
- Surplus trains at stub termini (would wait > `turnback.stubMaxLayoverS`, or every dead-ended berth is taken) pull in to the yard instead of queueing. Timing pull-ins into gaps between scheduled trains was tried and made no measurable difference, so it isn't implemented.
- Pull-outs/pull-ins avoid running against the normal direction of traffic (`yard.againstTrafficPenalty`); turnbacks have their own speed (`turnback.speedFactor`).
- Playback (`playback.ts`) is pure: (movement file, prepared plan, graph, t) → positions. Keep it that way.
- Debug with `npm run build:movements -- --verbose` (per-terminus chaining stats) and `npm run validate:plan` (conflict hot spots).

## Dispatcher notes (`src/core/dispatch/`, PLAN.md §4.11)

- `build:movements` runs inferred runs through the signalling simulation (moving block, junction locks, sections for track used both ways, stub berths). Its output is still a movement file; playback stays pure. `--no-dispatch` writes the timetable-only plan for comparison.
- Deadlocks are prevented by resource order (see PLAN.md §4.11 "As built"), not by the breaker. A "deadlock broken" line in `validate:plan` is a bug to look at: `DISPATCH_DEBUG=1` prints the waits-for chain, `DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>` traces one train.

## Corrections

- Observations (`src/core/corrections/`) reference **service date + GTFS trip_id** or **stop + time**, never inferred run ids.
- SkyTrain: `railInputs()` turns them into dispatcher anchors (a stop at a time), cancellations, consists and parked trains. The dispatcher re-dispatches the date centrally (`build:dispatch` → `public/data/dispatch/<date>.json`, a patch of the runs that changed); playback marks positions observed within 90 s of a sighting and interpolated where times moved. Browsers never reconcile rail observations.
- Timetable vehicles (SeaBus, WCE, buses without RT): `reconcileScheduled()` in the app, as before.
- Disruptions (`data/disruptions/*.json`, format in its README): single-track sections and reduced headways for a period. `build:dispatch` re-plans each affected date (`src/core/disruption/apply.ts` → re-inferred runs with closures → dispatch). Only `"status": "confirmed"` entries apply. The RT service drafts them from TransLink alerts into `data/disruptions/drafts/` (gitignored); never confirm a draft without knowing which track stays open.
- A future rail real-time adapter should emit `Observation`s rather than touch playback.
- SeaBus AIS (PLAN.md §4.12): the RT leader streams aisstream.io and records to `data/ais-history/`; the browser turns fixes into `ScheduleCorrections` with `aisCorrections()` (`src/core/ais/match.ts`). Fixes anchor the timetable rather than being drawn raw, because they arrive in bursts.

## Scenarios

- `src/core/infra/network.ts` builds topology for both the OSM import and scenarios. `composeNetwork` rebuilds base + future + custom track by shared coordinates. Keep them on the same code path.
- Service operations live in `src/core/scenario/service.ts` and must not mutate the base plan (it's `structuredClone`d).
- Scenario outputs go to `public/data/scenarios/<name>/` (gitignored). Only the spec and custom geometry are committed.

## GTFS gotchas (verified against feed 26SEP_20260925)

- Times can exceed 24:00 and have a leading space: `" 5:05:00"`, `"25:30:00"`. Store as seconds since service-day start.
- Service days come from `calendar.txt` **and** `calendar_dates.txt`. `1` = weekday, `2` = Sat, `3` = Sun/holiday, plus supplementary IDs added by date (e.g. `1101` on Mon–Thu only). Holidays remove `1`.
- Rail `stop_times` reference **platform** stops (`"Waterfront Station @ Platform 2"`). Parents are `999xx` (Capstan = `99959`). Some Canada Line termini use `"… Station @ Canada Line"` with no platform number.
- Rail arrival equals departure (no dwell in the data). Dwell comes from config.
- `block_id` is **not** a physical train (Expo has ~133 weekday blocks). It's a hint only.
- `shape_dist_traveled` is in km.
- The undated `https://gtfs-static.translink.ca/gtfs/google_transit.zip` is the latest feed. Read `feed_info.txt` for the version and validity range.
- GTFS-RT (`https://gtfsapi.translink.ca/v3/{gtfsrealtime,gtfsposition,gtfsalerts}?apikey=…`) covers buses only (no SkyTrain, SeaBus, or WCE) and sends no CORS headers.

## Commands

(Planned; update as they become real.)

```sh
npm run dev              # Vite + local RT service at /rt/* (poller, cache, recorder) (working)
npm run server           # standalone RT service on :8787, e.g. to keep recording; also live dispatch (working)
npm run data:gtfs        # fetch latest GTFS + build plan.json and manifest (working)
npm run data             # fetch-gtfs, fetch-osm, import-osm, build-schedule, infer-runs, build-movements
npm run tiles            # build public/tiles/vancouver.pmtiles + fonts/sprites (working)
npm run data:osm         # fetch OSM tracks + import → data/infrastructure/*.generated.geojson (working)
npm run build:infra      # publish tracks + per-feed platform mapping to public/data (working)
npm run validate:infra   # graph / platform / routing / turnback / checklist checks (working)
npm run build:movements  # infer + dispatch train runs → public/data/feeds/<v>/movements/*.json [--verbose] [--no-dispatch] (working)
npm run validate:plan    # teleports (fail), conflicts, dispatch delays and broken deadlocks (report), fleet peaks (working)
npm run build:observations # validate + publish data/observations/*.json (working; format in data/observations/README.md)
npm run build:dispatch   # re-dispatch dates with observations or disruptions → public/data/dispatch/<date>.json + index.json (working)
npm run disruptions      # list/confirm/discard disruptions drafted from TransLink alerts [-- pull | confirm <id> [--keep "<stop>"] | discard <id>] (working)
npm run build:rt-profile # learn bus travel-time profiles from data/rt-history → public/data/feeds/<v>/rt-profile.json (working)
npx tsx scripts/eval-rt.ts [--test-last 3] [--set key=value] # replay recorded RT: prediction error and live-view jumps, old vs new
npx tsx scripts/probe-ais.ts [--minutes 30] # record raw aisstream.io messages for the SeaBus fleet and summarise them
npx tsx scripts/eval-ais.ts [YYYYMMDD]      # recorded SeaBus AIS vs the timetable: matches, lateness, vessels per block, berths
npm run scenario -- <name> # build data/scenarios/<name>/ → view at /?scenario=<name> (working; see data/scenarios/README.md)
npx tsx scripts/screenshot.ts out.png "/?date=2026-09-28&t=08:00:00&paused=1#map=14/49.28/-123.11" [--mobile] [--dark] [--pick expo]
npm test                 # vitest
npm run typecheck
```

## Workflow

- Gitignored build and runtime output: `data/raw/`, `data/rt-history/`, `data/ais-history/`, `data/dispatch-history/`, `public/data/`, `public/tiles/`, `public/basemap-assets/`.
- Vite restarts the dev server's RT service by itself when `server/` files imported by `vite.config.ts` change (seen 2026-09-28); restart `npm run dev` if a change isn't picked up.
- Route colours and names are baked into `plan.json` from `data/config/routes.json`; rebuild with `npx tsx scripts/build-schedule.ts --force` after editing it.
- After changing infrastructure, config, or pipeline code, rebuild and run both validators before calling the work done.
- For visual changes, run the app and look at it (`scripts/screenshot.ts` drives the local Chrome; `window.skytrain` is a debug handle with `map`, `clock`, `store`, `vehicles()`), especially at station zoom around Waterfront, Columbia/Sapperton, Commercial–Broadway, Lougheed, Edmonds (OMC 1), and Bridgeport, where the track work is densest. Check the phone layout too.
- Prefer small, reviewable commits per milestone step.
