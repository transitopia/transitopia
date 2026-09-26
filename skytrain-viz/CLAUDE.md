# CLAUDE.md

Guidance for working in this repo. The design lives in [PLAN.md](PLAN.md). Read it before making structural changes, and update it when a decision changes. Operations assumptions are tracked in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

## Scope

- **Routes**: Expo, Millennium, and Canada Lines (track-level); SeaBus and West Coast Express (shape-level); buses 99, R1, R2, R3, R4, R5. **No other bus routes.**
- **Stack**: TypeScript, Vite, and MapLibre GL JS v6 with a PMTiles vector basemap (Protomaps). Vehicles are drawn by our own WebGL2 custom layer (`src/app/layers/gl-polygons.ts`) using only MapLibre's public API. Don't reintroduce deck.gl: its MapLibre integration depends on private internals that v6 removed. Plain TS with no UI framework. MIT licensed.
- Desktop-first, but the map and time controls must work on phones. Keep chrome minimal.

## Ground rules

- **Never print, log, commit, or bundle the API key.** It lives in `.secrets` (`TRANSLINK_API_KEY=...`, gitignored). Only `server/` (and later `worker/`) reads it. Browser code must never see it.
- **Never let client requests trigger TransLink API calls.** A single poller fetches upstream on a fixed interval. Clients only read the cached snapshot.
- **Positions are a pure function of (plan, overlays, t).** Don't introduce frame-stepped simulation state. Seek, rewind, and fast-forward depend on this.
- **Every vehicle state carries provenance** (`observed | interpolated | estimated`) and a source. Never render an estimate as if it were observed.
- **`src/core/` stays DOM-free.** It's shared by build scripts, tests, and workers.
- **Infrastructure is data.** Base geometry is imported from OSM (`tracks.generated.geojson`, don't hand-edit it). Fixes go in `data/infrastructure/overrides.json`. The result must pass `npm run validate:infra`.
- **Assumptions go in `data/config/`** with a comment citing the source or saying "guess", and a cross-reference to the matching item in `docs/OPEN-QUESTIONS.md`. No magic numbers in code.
- Select GTFS routes **by name** (`route_long_name` "Expo Line", `route_short_name` "099"/"R1"/"WCE", etc.), never by `route_id`. IDs change between feeds.
- Timetables: support the current feed and every future feed. Pick the feed for a date via the manifest (newest feed covering that date).

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
npm run dev              # Vite + local RT service (poller, cache, recorder)
npm run data:gtfs        # fetch latest GTFS + build plan.json and manifest (working)
npm run data             # fetch-gtfs, fetch-osm, import-osm, build-schedule, infer-runs, build-movements
npm run tiles            # build public/tiles/vancouver.pmtiles + fonts/sprites (working)
npx tsx scripts/screenshot.ts out.png "/?date=2026-09-28&t=08:00:00&paused=1#map=14/49.28/-123.11" [--mobile] [--dark] [--pick expo]
npm run scenario <name>  # build a scenario from data/scenarios/<name>/
npm run validate:infra   # track graph checks
npm run validate:plan    # conflicts, continuity, fleet caps
npm test                 # vitest
npm run typecheck
```

## Workflow

- Gitignored build and runtime output: `data/raw/`, `data/rt-history/`, `public/data/`, `public/tiles/`, `public/basemap-assets/`.
- Route colours and names are baked into `plan.json` from `data/config/routes.json`; rebuild with `npx tsx scripts/build-schedule.ts --force` after editing it.
- After changing infrastructure, config, or pipeline code, rebuild and run both validators before calling the work done.
- For visual changes, run the app and look at it (`scripts/screenshot.ts` drives the local Chrome; `window.skytrain` is a debug handle with `map`, `clock`, `store`, `vehicles()`), especially at station zoom around Waterfront, Columbia/Sapperton, Commercial–Broadway, Lougheed, Edmonds (OMC 1), and Bridgeport, where the track work is densest. Check the phone layout too.
- Prefer small, reviewable commits per milestone step.
