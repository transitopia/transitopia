# SkyTrain Viz

An interactive, to-scale vector map of Vancouver's SkyTrain network. It animates every train on the correct track, including switches, pocket tracks, turnbacks, and moves to and from the Operations & Maintenance Centres. It also shows the SeaBus, the West Coast Express, and the express bus routes 99, R1, R2, R3, R4, and R5.

- **SkyTrain, SeaBus, and West Coast Express** positions are *estimated* from TransLink's published GTFS schedule. No public real-time feed exists for them.
- **Express bus** positions are *observed* from TransLink's GTFS-realtime feed when live or when recorded history exists, and *estimated* from the schedule otherwise. The map shows which is which.
- Time plays in real time by default. You can pause, rewind, fast-forward, or jump to any date in the current or any future published timetable. Different days get different schedules (weekday, Mon–Thu extras, Saturday, Sunday/holiday).

> **Status:** in development. Working so far: timetables, basemap, schedule-based vehicles on GTFS shapes, time controls, and live plus recorded bus positions, the track-level SkyTrain network, and trains running on it: inferred runs with turnbacks at termini, stub-berth alternation, and pull-outs and pull-ins at the OMCs. Corrections from observation files (`data/observations/`) are applied too. Next: scenarios. See [PLAN.md](PLAN.md) and [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

## Quick start

```sh
npm install
npm run tiles       # build the Metro Vancouver PMTiles basemap (one-time)
npm run data:gtfs   # fetch the latest GTFS feed and build the timetable data
npm run data:osm    # fetch SkyTrain tracks from OpenStreetMap and import them
npm run build:infra # publish the track network and platform mapping
npm run build:movements # infer train runs and build per-day-type movement files
npm run dev         # app at http://localhost:5173, plus the local RT service
```

You need a TransLink Open API key for live and recorded bus positions. Put it in `.secrets` at the repo root (this file is gitignored):

```
TRANSLINK_API_KEY=your-key-here
```

Without a key, everything runs in schedule-only (estimated) mode.

While `npm run dev` is running, the RT service polls TransLink every 20 s for positions and every 60 s for delays, however many browser tabs are open. It records bus positions to `data/rt-history/`, so rewinding shows real positions for any time it was running. A red strip above the time slider marks those periods, and the "Buses: live / recorded / estimated" badge says which you're seeing. To keep recording without the app open, run `npm run server`.

## How it works (short version)

1. **Track graph** (`data/infrastructure/`): imported from OpenStreetMap, which maps SkyTrain per track, including switches, pockets, and OMC yards. Hand fixes are layered on top and checked against the published track diagram.
2. **Timetables** (`scripts/build-schedule.ts`): each GTFS feed version is filtered to our routes and resolved per service day.
3. **Run inference** (`scripts/infer-runs.ts`): scheduled trips are chained into physical train runs, with yard pull-outs and pull-ins added.
4. **Movements** (`scripts/build-movements.ts`): each run is routed over the track graph and given a timed kinematic profile.
5. **Browser**: MapLibre GL renders a PMTiles basemap and the transit layers. Every vehicle position is a pure function of *(movements, overlays, time)*, so seeking and rewinding are instant.

Corrections (observed data) and scenarios (alternate track or service, defined in config files under `data/scenarios/`) are layers on top of the same pipeline. See [PLAN.md §4.7–4.8](PLAN.md).

## Data sources and attribution

- TransLink GTFS static and GTFS-realtime: [app developer resources](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-realtime). Route and schedule data © TransLink.
- Track geometry and basemap data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Basemap tiles are built with [Protomaps](https://protomaps.com/).
- Track topology cross-checked against the [Vancouver SkyTrain track diagram v3](https://commons.wikimedia.org/wiki/File:Vancouver_SkyTrain_track_diagram_v3.svg) (Wikimedia Commons).

This is not an official TransLink product. Train positions are estimates.

## License

[MIT](LICENSE). Third-party data remains under its own license (see above).
