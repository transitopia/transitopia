# Transit engine: design

How Transitopia turns timetables, OpenStreetMap track and real-time data into the vehicles on `/transit`. The code is in `packages/transit-core/src/` (DOM-free, shared by the pipelines, the server, tests and the browser); the parts that run in the browser are in [packages/transit-map](../transit-map/README.md), and the server's side in [apps/server](../../apps/server/README.md). Region-specific facts and assumptions are in [config/regions/metro-vancouver/README.md](../../regions/metro-vancouver/README.md) and its [OPEN-QUESTIONS.md](../../regions/metro-vancouver/OPEN-QUESTIONS.md) (cited below as "OPEN-QUESTIONS #N").

## Overview

The engine animates, on a to-scale vector map of Metro Vancouver (and a few BC Transit bus routes in Greater Victoria and Kelowna: [docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)):

- **SkyTrain** (Expo, Millennium and Canada Lines): every train on the correct track, through switches, pocket tracks and turnbacks, and moving to and from the operations and maintenance centres (OMCs) and yards as trains enter and leave service. Positions are **inferred from the schedule**, refined by corrections and dispatched through a signalling simulation.
- **SeaBus** and **West Coast Express**: from the schedule along simpler geometry. SeaBus is anchored by live AIS.
- **Express buses** (99, R1–R6): real positions from GTFS-realtime when live or recorded, predicted between fixes, and schedule estimates otherwise.

It plays in real time by default and can pause, rewind, fast-forward and jump to any date in the current or any future published timetable. Scenarios (alternate track and service) go through the same pipeline.

```
                  BUILD TIME and SERVER                                    BROWSER
 ┌───────────────┐   ┌─────────────┐   ┌──────────────────┐   ┌─────────────────────────────────┐
 │ GTFS static   │──▶│ ingest/     │──▶│ service plan     │──▶│ Clock (t, rate, date)           │
 │ (every feed   │   │ filter/     │   │ per feed version │   │        │                        │
 │  version)     │   │ normalize   │   └────────┬─────────┘   │        ▼                        │
 └───────────────┘   └─────────────┘            │             │ Playback:                       │
 ┌───────────────┐   ┌─────────────┐            │ run         │  f(movements, t) → vehicles     │
 │ OSM (Overpass)│──▶│ import +    │──▶ track ─▶│ inference + │  each with provenance           │
 └───────────────┘   │ overrides   │    graph   │ dispatcher  │        ▲                        │
 ┌───────────────┐   └─────────────┘            ▼             │        │ overlays               │
 │ Scenarios,    │──────────────────▶ ┌──────────────────┐    │  dispatch patches · bus RT ·    │
 │ corrections   │                    │ movement plan    │───▶│  AIS · history                  │
 └───────────────┘                    │ per service day  │    │                                 │
                                      └──────────────────┘    │ MapLibre + WebGL vehicle layer  │
                                                              └──────────────┬──────────────────┘
                                                                             │ /rt/*
                                                          ┌──────────────────▼───────────────────┐
                                                          │ server: one poller within the budget,│
                                                          │ recorder, live dispatcher, AIS       │
                                                          └──────────────────────────────────────┘
```

The core design principle is that **every vehicle position is a pure function of (movement plan, overlays, time)**. Nothing steps a simulation forward frame by frame. That makes seeking, rewinding and 1000× fast-forward trivial and deterministic, and it makes corrections and scenarios composable, because they just produce a different plan or overlay. The [dispatcher](#dispatcher) keeps this: it runs centrally (build time, the server), and its output is one more versioned plan that playback reads.

Every vehicle state carries a **provenance** (`observed | interpolated | estimated`) and a `source`. The same concept drives the bus real-versus-estimated indicator and rail corrections.

## Source data

Verified 2026-09-25 against TransLink GTFS feed `26SEP_20260925` (valid 2026-09-07 → 2027-01-03), OSM, and the Wikipedia track diagram v3 (mid-2021).

### TransLink GTFS static

| Fact | Implication |
|---|---|
| Rail `stop_times` use **platform-level stops** (e.g. `Waterfront Station @ Platform 2`), with parent stations `999xx`. Capstan (`99959`) is present. | Trips are pinned to specific tracks at every station: the key input for track-level placement. |
| Some Canada Line termini use a non-platform stop (`Richmond-Brighouse Station @ Canada Line`). | The platform is inferred there. |
| Scheduled arrival equals departure at rail stops (zero dwell). | Dwell comes from config. |
| Rail trips include short-turns (Production Way, Braid, New Westminster, Lougheed, Bridgeport) and oddities (Expo trips ending at Lougheed P2; Millennium trips from Lougheed P3). | They reveal where turnbacks and pocket tracks are used. |
| `block_id` chains trips, but Expo has 133 weekday blocks with gaps, far more than the real fleet in service. | **Blocks are not physical trains.** Runs are inferred ([below](#run-inference)). |
| Weekday rail blocks start and end mostly at termini: Expo at King George (33), Waterfront (30), Production Way, Braid and Edmonds (27, next to OMC 1); Millennium at Lafarge Lake–Douglas (50 of 89); Canada at Bridgeport (12, next to its OMC). | OMC and yard moves are **not in GTFS**: they're modelled as empty moves, with layup practice as config. |
| Service IDs: `1` = weekday, `2` = Saturday, `3` = Sunday/holiday, plus supplementary IDs added via `calendar_dates` (e.g. `1101` = extras Mon–Thu, not Fri). Holidays remove `1`. | `activeServices(date)` resolves them; never hard-code weekday/weekend. |
| Times go past 24:00 and have leading spaces (`" 5:05:00"`). `shape_dist_traveled` is in km. | Parser details. |
| West Coast Express: 10 trips per weekday (5 each way), no weekend service. SeaBus: 8 blocks. | Both are simple. |
| The undated `gtfs-static.translink.ca/gtfs/google_transit.zip` serves the same file as the dated `History/<date>/` snapshot. | New and future timetables are easy to detect, and CI pins a dated snapshot. |
| Route IDs change between feeds. | Routes are selected by name, never by `route_id`. |

### TransLink GTFS-realtime

- The v3 endpoints (`gtfsrealtime`, `gtfsposition`, `gtfsalerts`, `?apikey=`) cover **buses only**: zero entities for SkyTrain, SeaBus or WCE.
- They send **no CORS headers**, so they're proxied by the server, which also keeps the key secret.
- Trip updates drop a trip once it has run, cancelled or not (seen 2026-09-29), and alerts disappear once they're over, which is why the server records [service changes](../../apps/server/README.md#real-time-service).

### BC Transit GTFS and GTFS-realtime

Verified 2026-10-14 against the Victoria (operator 48) and Kelowna (operator 47) feeds ([bctransit.com/open-data](https://www.bctransit.com/open-data/), `feeds/bc-transit-*/feed.json`).

| Fact | Implication |
|---|---|
| Published by Consat (`bct.tmix.se`) with a new `feed_version` such as `202610140/20261013 21:00:00/20261014 04:00:00` on every export (daily), even with the same timetable. | Versions become directory names with `versionDir`; `fetch-gtfs` keeps a download only when its files differ from the newest archived version's (`zipSignature`). |
| No `calendar.txt`: every service is dated in `calendar_dates.txt`. UTF-8 byte-order marks. `shape_dist_traveled` in metres. | Handled by the generic reader (exceptions alone; `bom: true`); stops are projected onto shapes, never by `shape_dist_traveled`. |
| Route colours for every route (the 95 Blink is `#FCAF17`). | Drawn routes use the feed's colours (no `color` in `routes.json`). |
| Exchange bays have no `@`: `Langford Exch (Jacklin Rd) Bay D`, `UBCO Exchange Bay C`, `Legislature Exch`. | `src/plan/exchanges.ts` reads both naming styles. |
| GTFS-realtime with no key and no stated limit: positions for every bus with its trip, trip updates (delays, `CANCELED` trips, `SKIPPED` stops) and alerts. Fixes were p50 ~8 s old when fetched. Vehicle labels are long ids (`3131357525`), not fleet numbers. | The same GTFS-RT handling as TransLink's, within its own budget. |

### OpenStreetMap

OSM maps SkyTrain **per track** in detail: 264 `railway=switch` nodes, 45+ crossovers, named pockets (Metrotown, Vanness, Holdom, Moody Centre, Great Northern, "Mainline Pocket", Waterfront Tail), and yard tracks: the **Canada Line OMC** (~50 tracks, east of Bridgeport), **OMC 1** (~75 tracks across two clusters, south of Edmonds), and a **~16-track yard near Inlet Centre/Coquitlam Central**. OSM is our primary source for geometry *and* topology.

OSM's roads are also where buses run: `fetch-osm-roads` takes every public road class, busways, service roads open to buses and service roads within 150 m of a bus stop (exchange loops are often plain service roads) for the bbox of the regions showing each feed (TransLink, 2026-10-17: 123,414 ways, 618,799 nodes, 96 MB). See [Bus corridors](#bus-corridors).

### Wikipedia track diagram

The diagram labels the OMC leads ("To OMC" between Edmonds and 22nd Street, and at Bridgeport) and notes "an extra storage facility in Coquitlam" ("east of Falcon Drive"). It predates Capstan. It's an independent checklist for the OSM-derived graph, not a source of geometry.

## Track graph

The heart of the engine. It lives as versioned data in `config/regions/metro-vancouver/infrastructure/`, not in code (`src/infra/`).

**Entities**

- **Track segment**: an id (`w<wayId>.<n>`: OSM ways split at junctions), a WGS84 polyline, a line tag, a length, and a kind: `main | pocket | tail | crossover | yard | lead`.
- **Node**: a junction, a buffer (end of track) or a link. Turns are derived from geometry: legs that deviate by ≤ 35° pass straight through, so routes can't reverse through a frog and no per-switch tagging is needed. Mistakes are fixed with `turns` in `overrides.json`. Diamond crossings pass straight across only.
- **Platform**: a span on a segment, plus the GTFS `stop_id`(s) it serves and a stopping point.
- **Yard**: segments of kind `yard`, from OSM at full detail: OMC 1 (Edmonds; Expo and Millennium), OMC 3 (Falcon Drive, Coquitlam; Millennium) and the Canada Line OMC (Bridgeport). Yards aren't named in the model: pull-outs and pull-ins use the nearest yard track by distance.

**Sourcing**

1. `pipelines/fetch-osm.ts` runs an Overpass query for `railway=subway` ways and `railway=switch` nodes in the region's bbox, into `var/raw/osm/`.
2. `pipelines/import-osm.ts` converts it into our format (`src/infra/network.ts` builds the topology, the same code scenarios use) and writes `tracks.generated.geojson`. Track with a future `opening_date` (e.g. the Broadway Extension) goes to `future.generated.geojson`, for scenarios only.
3. **Hand fixes** live in `overrides.json`: switch pairings OSM doesn't encode, excluded ways (e.g. track closed for works), `addTrack` (GeoJSON track missing from OSM), platform pins and role-based `patternPlatforms` rules (pins for trips that terminate at versus pass through a station, for temporary operations such as the OMC4 works at Braid). They refer to OSM ids and coordinates, never to generated segment ids, so OSM can be re-pulled without losing them.
4. `npm run validate:infra` checks the result ([Validation](#validation)).

**Platform mapping** (`src/infra/platforms.ts`) is a global optimisation, not a nearest-track snap: route consistency, distinct tracks per numbered platform (except terminal arrival and departure berths), and every trip end must be able to turn back or pull in to a yard. Two Canada Line Waterfront platforms are pinned by override.

**Rendering at scale** ([transit-map](../transit-map/README.md#rendering)): parallel tracks are about 4 m apart, sub-pixel at city zoom, so low zooms draw one line per corridor; station zoom draws true geometry with switches and platforms. Trains are drawn to scale as chains of car polygons following the track when zoomed in, and as fixed-size markers zoomed out.

## Timetables

`pipelines/fetch-gtfs.ts` and `pipelines/build-schedule.ts`; types in `src/plan/types.ts`.

- **Feed discovery**, for each feed (`config/feeds/<feed>/feed.json` → `static.url`): fetch the latest zip and read `feed_info.txt` (`feed_version`, `feed_start_date`, `feed_end_date`). A new version is archived to `var/raw/gtfs/<feed>/<version dir>/` and built, unless its files are the same as the newest archived version's (BC Transit re-exports daily). Previously built versions are kept. The server does this daily and archives every version.
- **Rebuilds**: a plan records a hash of what built it besides its feed (`inputs`: `PLAN_FORMAT` in `build-schedule` and the files it reads: the feed's `feed.json` and `routes.json`, and SeaBus berths where a region showing it has them), and the build redoes any plan whose hash differs, so editing `routes.json` or changing the plan's format reaches plans already built (on the server too, whose daily build otherwise only builds new feeds). Bump `PLAN_FORMAT` whenever the script writes something different from the same feed and config.
- **Manifest**: each feed's `var/public/data/feeds/<feed>/manifest.json` lists its versions with their validity ranges. `feedForDate(date)` picks the newest feed whose range covers the date, which handles current and future timetables, including a newer feed superseding the tail of an older one. The date picker is bounded by the union of the ranges.
- **Filter** to the routes in the feed's `config/feeds/<feed>/routes.json`, **by name**. Route colours, names and categories are baked into the plan from the same file. The feed's other bus routes go in the plan's catalogue ([below](#route-catalogue)).
- **Normalize** into a compact service plan per feed version: trips (route, direction, headsign, service_id, block_id, shape_id, and `(stop_id, arr, dep)` in seconds since service-day start), stops with platform→parent mapping, simplified shapes, calendar and calendar_dates. Bus shapes lose vertices placed on a stop just off the road (`removeStopSpurs` in `src/geo.ts`): BC Transit's sparse shapes have one at each curbside stop, which drew as a bump or a spur to the curb. SeaBus shapes are replaced by berth-to-berth lanes ([below](#seabus-and-west-coast-express)).
- **Service-day resolver**: `activeServices(date)` applies calendar ranges, weekday flags, and add/remove exceptions. Trips after 24:00 belong to the previous service day. Local times come from the runtime's tzdata.
- **Re-timing**: SkyTrain, WCE and SeaBus trips are re-timed within ±45 s of GTFS (which rounds to the minute) in proportion to each hop's physical minimum time (`retime` in `src/schedule/engine.ts`). Without this, some hops are impossibly fast.

### Route catalogue

The map draws only the routes in the feed's `routes.json`, but cards list every bus route in the feed. `build-schedule` keeps each other bus route (GTFS `route_type` 3) in the plan's `catalog` (`CatalogRoute`): its key, name and category ("regular"), a neutral colour (GTFS gives buses none), which of the plan's stops it serves, and its trips' start times (minutes, per service and direction). That is all a stop card needs to list it and a route card needs for its frequency (`routeMinutes` counts catalogue starts the same way as trips), without its stop times or shape: about 0.3 MB more per plan instead of tens of MB. `PreparedPlan.catalog` and `catalogAtStop` index it. So that a station's or exchange's card lists every route at it, the plan also keeps the bays there that only catalogue routes use (`bayAtPlace`: the name of one of its bays, or beside a station, within 400 m); `busHubs` groups them with the rest, but a group of bays no drawn bus uses isn't an exchange of its own, so bays elsewhere wait until their buses are drawn. A catalogue route's key is its short name as riders know it ("025" → "25", "N17"), never the `route_id`, so `?place=route:25` survives feed changes; real-time data still keys vehicles on untracked routes as `gtfs:<route_id>` ([Buses](#buses)).

Categories, for the layers panel: **rapid** is dedicated right of way (SkyTrain, SeaBus, West Coast Express), **frequent** the 99 B-Line and RapidBus (frequent, but not true BRT), **regular** every other bus. They're set by hand in `routes.json` for now (in Victoria, the 15 and 70 are drawn as regular); frequent vs regular is meant to be computed from scheduled frequency when the plan is built. When every route is drawn, the catalogue is the part of the plan loaded up front: what routes exist, where they stop and how often they run, with each route's trips loaded when needed.

## Departures

Station and stop cards (`src/schedule/departures.ts`) list what leaves a stop after a given time: every trip whose pattern serves the stop (a station's platforms and bus bays included), on the given service dates (the previous day too, for its trips after midnight), at the trip's effective departure time (re-timed rail, modelled dwell; `PreparedTrip.dep`). A trip ending at the stop isn't a departure, and neither is a stop where nobody can board. Where real-time corrections know a trip's delay (the anchors the browser already applies to bus positions, `ScheduleCorrections`), the time is shifted and marked `predicted` (a projected delay) or `observed`; cancelled trips stay in the list, marked. SkyTrain departures come from the timetable, not the dispatched movement plan, so trains drawn on the map can differ by a minute or two.

Departures are grouped by route and destination (`groupDepartures`), ordered by platform or bus bay number, then by the soonest departure (groups without a number last). How often a group runs is 60 / its departures in the hour from the shown time (`minutesBetween`). Groups whose next stops are the same, in order, for at least two stops or 500 m share a stretch (`sharedStretches`), which runs to where they split (stations compared by station, not platform): the site shows a combined row for it. The distance lets a short-turn of a rapid route with stops far apart count (the 97's trips to Queensway Exchange share a single stop with the rest from Westside Rd, 4.8 km on), while routes that only run together to the next corner don't. Places are named the same way everywhere (`src/plan/display.ts` → `placeName`): the station, the exchange, or a street stop's cross street.

### Bus exchanges

GTFS bus bays ("UBC Exchange @ Bay 7", "Joyce Station @ Bay 1 Unload Only", "Phibbs Exchange @") have no `parent_station`, so `busHubs` (`src/plan/exchanges.ts`) groups the bays the plan's buses call at: bays with the same name, each within 250 m of another, are one exchange. A group within 400 m of a station whose name starts with the same word belongs to that station (bay names don't always match the station's: "Joyce Station", "Scott Rd Station"), and all of a station's groups are one. The rest are exchanges of their own, identified by a slug of their name ("ubc-exchange"). Stations' and exchanges' cards list departures from all their bays, with the bay number where a rail departure would have its platform. An exchange appears only once one of its buses is drawn; then its bays that only catalogue routes use are kept too ([Route catalogue](#route-catalogue)).

A route's frequency (`src/schedule/frequency.ts`) counts its trips starting in each hour, per direction, and takes the busier direction: 60 / trips is the minutes between them. The route card's day types are the distinct sets of services that run on the coming dates (`dayTypes`), so a feed with Mon–Thu, Friday, Saturday and Sunday/holiday services shows four.

## Run inference

`src/movement/build.ts`, run by `npm run build:movements`. This is where the "best guess" lives, so it's explicit, configurable (`config/regions/metro-vancouver/operations.json`) and replaceable. For each SkyTrain line and each distinct service-day pattern:

1. **Chain trips into runs.** The GTFS block successor is used only when it starts where the last trip ended (blocks aren't physical trains: [region README](../../regions/metro-vancouver/README.md#gtfs-blocks)), and only when no earlier departure from the same platform track is still unserved: the train would stand on that platform in the way of whichever train runs it (at Production Way–University this sent a yard pull-out into an occupied berth). Otherwise trips are chained first-in-first-out to the earliest feasible departure: same line, the arrival platform can reach the departure platform through a legal turnback in the track graph, and the layover is at least the terminus's minimum.
2. **Turnbacks** choose, by cost, between the GTFS departure platform (via tail, pocket or main-line reversals) and reversing in place. In-place turnbacks get stub berths by occupancy, pulled up to the buffer (but not beyond `turnback.maxPullUpM`). Turnbacks run at their own speed (`turnback.speedFactor`).
3. **Pull-outs and pull-ins.** A run's first trip gets a pull-out from the nearest reachable yard by track distance, timed to arrive before its first departure; its last trip gets a pull-in. Every run starts and ends in a yard: overnight layup on the line, which really happens near King George and along the Millennium Line ([region README](../../regions/metro-vancouver/README.md#yards-and-overnight-layup)), isn't modelled. They keep to the normal direction of traffic where they can (`yard.againstTrafficPenalty`). When the matcher needs a new train mid-day it pulls one from a yard, and when service thins it sends one back: these are the trains the map shows entering and leaving service.
4. **Surplus trains at stub termini** (that would wait longer than `turnback.stubMaxLayoverS`, or when every dead-ended berth is taken) return to the yard instead of queueing, as operators run them empty between scheduled trains. Timing these pull-ins into gaps between scheduled trains was tried and made no measurable difference.
5. **Consist placeholder.** Each run gets `consist: { type?, cars?, carNumbers? }` from per-line defaults: usually unknown, and the hook for car-number data.

Output: **runs**, each an ordered list of movements (revenue trips and empty moves). `npm run build:movements -- --verbose` prints per-terminus chaining statistics.

## Movements and playback

`src/movement/` (`kinematics.ts`, `playback.ts`, `types.ts`) and `src/infra/graph.ts`. The same code builds scenarios and feeds the dispatcher.

- **Routing**: each leg (platform → platform, yard → platform, turnback) is routed on the track graph by shortest path, respecting turns. Legs start and end on the platform's own track. Revenue trains keep to main track.
- **Timed paths**: each leg becomes a list of `(edgeId, fromOffset, toOffset)` plus a time profile. Per-line kinematics (acceleration, deceleration, top speed, dwell; `config/defaults/kinematics.json`) are fitted so run time matches the schedule; slack goes into the dwell.
- **Movement files**: `var/public/data/feeds/translink/<v>/movements/*.json`, one per service pattern. Trips that run on plan are stored by reference; trips the dispatcher changed carry explicit times. Schema version 1 is timetable positions only, version 2 is dispatched.
- **Playback** (`playback.ts`) is pure: (movement file, prepared plan, graph, t) → positions. `positionAt(run, t)` binary-searches the timed path, applies the kinematic interpolation, and maps the edge offset to a position and bearing. Keep it pure.

## SeaBus and West Coast Express

- **Schedule-based**, interpolated along their paths with easing between stops. Vessels and trainsets are chained by `block_id`, which follows one vessel per block for SeaBus (2 vessels in service, 3 at weekday peaks, 1 late evening). Out-of-service vessels are hidden. WCE trainsets are shown only while in service (OPEN-QUESTIONS #15).
- **SeaBus lanes**: vessels run berth to berth along keep-right lanes traced from AIS instead of the GTFS shapes (a straight line between the terminals). `src/plan/ferry-berths.ts`, applied by `build-schedule`, runs every vessel between the same pair of berths (west–west or east–east), keeping pattern ids unchanged because movement files reference them. Berths and lanes are in `config/regions/metro-vancouver/infrastructure/seabus.json`, the default pair in `config/regions/metro-vancouver/seabus.json`. The plan carries every pair's paths, and [AIS](#seabus-ais) picks the day's pair.
- Live AIS fixes anchor the SeaBus timetable ([SeaBus AIS](#seabus-ais)).

## Buses

**Route lines**: with corridors, every bus route is drawn through [bus corridors](#bus-corridors): regular routes as frequency tiers, routes with their own colour (the 99 and RapidBus) in it on top. Without corridors, bus routes are lines of their own, split by coverage (`src/plan/coverage.ts`): sections served by under 25 % of the route's busiest section (e.g. the 99 east of Commercial–Broadway) and sections where no passengers can be aboard are drawn dotted. The latter comes from GTFS `pickup_type`/`drop_off_type`, kept per pattern stop as `access`: e.g. the 99 drops off at Commercial Dr @ N Grandview Hwy (58491), lays over at N Grandview Hwy @ Commercial Dr (58620: no pickup or drop-off), and picks up at Commercial–Broadway Bay 5 (50913). Stops where nobody can board or alight get no marker. Stops are drawn as ticks toward their side of the street (`src/plan/bus-stops.ts`).

**Positions** are resolved per vehicle, in priority order:

1. **Observed**: a live or recorded fix at (or within 10 s of) *t*.
2. **Interpolated**: between fixes, or predicted from the last one.
3. **Estimated**: the schedule, delay-shifted where a delay is known. Used when no RT data covers *t*: the recorder wasn't running, future times, or a gap.

Fixes arrive 1–5 minutes apart within the [request budget](../../docs/DESIGN.md#upstream-request-budget), so the live view always predicts (`src/rt/profile.ts`, `timeline.ts`; settings in `config/defaults/rt.json` → `prediction`, OPEN-QUESTIONS #25):

- **Travel-time profile**, learned from recorded history (`npm run build:rt-profile` → `var/public/data/feeds/<feed>/<v>/rt-profile.json`): pace per 50 m bin along each trip shape by time-of-day band (congestion, signals), and expected dwell per stop. Slow time within 75 m of a stop (versus the pace nearby) is moved into its dwell, which makes buses visibly stop at a small cost in average accuracy. Gaps fall back to the all-day profile, then the timetable's running times with a default dwell, then a default speed.
- **Prediction** walks the bus forward from its last fix with the profile, stopping at each upcoming stop for its expected dwell. A bus whose predicted dwell ends leaves on time even without a new fix (RT reporting gaps are likelier than long dwells). Checked against two GPX rides on the 99 (2026-10-12): expected dwells were within p50 8–11 s of the real ones, with no overall bias.
- **Corrections glide**: when a new fix becomes known (client receipt live, fetch time when recorded), a bus that turns out further ahead glides forward (≤ 8 m/s faster, ≤ 25 s); one that turns out behind holds still until the prediction catches up, never reversing. Corrections over 600 m snap. Between two known fixes (recorded playback), motion follows the profile scaled to fit both, so stops show there too.
- **Schedule estimates** for buses (no RT coverage, e.g. fast-forwarding past the live edge) use the same profile between timetable times ≥ 3 minutes apart, scaled to meet them: the bus stops at each stop and holds at those anchor stops until its timetable time.
- **Delays carry forward** (`src/rt/carry.ts`, `config/defaults/rt.json` → `carry`): each bus's delay against that paced schedule, measured where prediction leaves it (the fix + `maxExtrapolateS`: the poll interval plus `extrapolateSlackS`), shifts the rest of its trip; lateness carries into its next 2 trips less layover beyond a 120 s turnaround, early running doesn't. A bus unreported for longer than that continues as a delay-shifted estimate (unless its block is shown from RT) instead of vanishing; the estimate keeps the RT vehicle's id and fleet number, so a selection or camera follow carries across the hand-over and back when the next fix arrives, and fast-forwarding past the live edge keeps every known delay. Hand-over from RT to estimate: median 8 m, p90 14 m. Positions stay *estimated*.
- Implausible fixes (null island, > 45 m/s jumps, lone spikes the next fix contradicts) are dropped.
- **Standing and layovers**: a bus never moves backwards along its trip. A fix behind the furthest point reached (≤ 150 m) holds it there, standing. **Between trips** (before its trip's scheduled departure, or a late start that hasn't left its first stop or layover spot) a bus is drawn only at its next trip's first stop (within 100 m along the route), standing and facing along the route, with a "Between trips" note and no delay; elsewhere (GPS off route, repositioning) it isn't drawn until it starts the trip. In recorded playback a bus whose next fix is hidden stands where it was.
- **Next stop and delay** come from the position whenever the bus is placed on its route: the next stop along the route after where it's shown, and the delay against the paced schedule at the fix (as carried forward). TransLink's own are worse: its vehicle positions' `stop_id` is mostly the stop the bus last passed (86 % of fixes on the drawn routes, 2026-10-01 to 10-12; 11 % the stop ahead), every status is `IN_TRANSIT_TO`, and its delay is a trip-update prediction up to a poll interval (4–10 minutes) old, which differed from the position's by a median 44 s and by over 2 minutes for 15 % of fixes (2026-10-08). TransLink's are kept for buses off their route (detours) and, for delay, where there's no predictor.
- **Shifted GPS**: some buses report positions hundreds of metres from where they are (seen 2026-09-26: an R4 and a 99 ~350–620 m north of their routes for 30+ minutes, on time; TransLink's stop matching stalls on such buses, so its next stop stays at stop 1 and its delay grows). Fixes 150 m–1 km off the trip's shape are placed on the route at their along-route position when they progress plausibly from the last placed fix (≤ 15 m/s, steady offset) or fit the timetable (± 20 minutes); they're *interpolated* and noted in the vehicle card. Fixes that can't be placed (e.g. to and from the depot, over 1 km off) are shown as reported with a note and no delay. In recorded data, 98.7 % of fixes are within 50 m of their shape.
- **Service changes** (`src/rt/changes.ts`, OPEN-QUESTIONS #28): TransLink publishes cancellations as trip updates (`CANCELED`) and as "no service" alerts naming the trip, skipped stops as `SKIPPED` stop time updates, and detours only as alert text (route, maybe direction, affected stops, the path in words; no shape and no `TripModifications`), so detour paths aren't drawn. Cancelled trips get no schedule estimate, carry no delay and absorb none; a bus still reporting one is drawn from its fixes with a note. A "no service" alert that lists stops is a partial cancellation, so only those stops count as skipped. Skipped stops are never a bus's next stop and get no predicted dwell. A bus off its route within `detourNearM` of a stop named by an active detour alert for its route is labelled "On detour" with the alert's text, keeps TransLink's delay, and is never taken for shifted GPS.
- **Evaluation**: `npx tsx pipelines/eval-rt.ts` trains on older hours and replays the latest as the live view would. On 2026-09-26 (8 h train, 3 h test, ~30 s fixes): median error 30 s ahead 94 → 50 m, 60 s ahead 188 → 70 m; live display error 120 → 64 m; jumps when data arrives: median 63 → 0 m. At the budgeted cadence (2026-09-29 07:00–10:00): p50/p90 error 82/287 m 60 s ahead, 156/559 m at ~150 s, 243/992 m at ~300 s. On production recordings (trained on 2026-09-25 to 10-11, 311 h, tested at the real cadence): a weekday (10-08 07:00–19:00) p50/p90 124/439 m at ~150 s and 183/669 m at ~300 s; a Sunday 144/502 and 207/725 m; Thanksgiving Monday 167/606 and 320/1081 m (lighter traffic than the profile expects). Adapting to the bus's recent pace (`paceWeight` 0.3–0.6) is worse on weekdays and weekends and better only on the holiday. Profiles trained only on weekends predict a Sunday ~7 % better (on 117 h); weekday-only gains ~1 % (day-type profiles: [#162](https://github.com/transitopia/transitopia/issues/162)).
- **Ground truth** (`npx tsx pipelines/eval-gpx.ts`, GPX ridden on the bus): on two 99 rides (2026-10-12, 39 and 43 min), GTFS-RT fixes were p50/p90 15/58 m from the bus, their timestamps ~3 s behind reality, and ~28 s old when fetched (p90 46 s); one carried a position 500 m (~140 s) old under a fresh timestamp. Across the recordings, 0.28 % of fixes land over 150 m behind the bus's previous fix, and the next fix contradicts about half of those. The buses stood still at stops for 350–380 s per ride and as long or longer elsewhere (signals, traffic; one 290 s hold). The live view was p50/p90 111/320 m from the bus (dead reckoning: 212/629 m), and recorded playback 38/129 m.

## Bus corridors

Drawing every bus route as its own line makes a tangle of overlapping lines in which only the top one shows. Instead, each street is one line, coloured and weighted by how often buses pass along it.

**Matching shapes to roads** (`src/plan/road-match.ts`, at build time in `build-schedule` when the feed's roads were fetched). GTFS shapes are coarse: TransLink's cut corners, chord across exchange loops and jog toward stops. Each bus shape is sampled every 25 m and matched to the road graph with a hidden Markov model: candidates are the directed road edges within 30 m of a sample (55 m when none are), scored by their distance (σ 10 m), and transitions between samples by how far the route along the roads differs from the straight distance (β 12 m). A step of under 1 m back along the same road counts as standing still (shapes repeat points, and the repeat can project a little behind). Routes respect one-way streets (except `oneway:bus=no`), and cost more on residential and service roads, more again on roads closed to traffic but not tagged for buses (Coquitlam Central's bus loop is tagged that way), parking aisles and drive-throughs, so the shape decides when it's close to one. Each sample takes its 8 nearest candidates; where none of them connect to the last sample's, the candidates of the 24 samples before (600 m) grow to every road within 55 m and the match resumes from there (keeping the match as it was if that doesn't get past the break), since the road the route is on can be crowded out of the nearest by others alongside it (a motorway's ways and links beside Phibbs Exchange's bus ramp onto the Ironworkers bridge), or the nearer of two roads one above the other can turn off (Granville Street under the Granville Bridge). Where still nothing connects, the shape's own geometry is kept, joined to where the matched stretches end. The matched geometry replaces the shape, so stop distances, vehicles and stop ticks all follow the streets. Matched shapes and corridors are simplified together (`keptRoadNodes`): the roads all shapes use are joined into stretches between junctions and simplified once (1 m), and every line along a road keeps those nodes, so a route drawn on its own, its other shapes and its corridors coincide exactly (simplifying each separately keeps different nodes on curves, a few pixels apart close in). Unmatched shapes are simplified at 4 m. All 1,026 TransLink bus shapes match in about 25 s.

**Corridors** (`src/plan/corridors.ts`, `plan.corridors`): each road edge lists the bus patterns that cover at least half of it; runs of edges used by the same patterns become one corridor, through nodes where only they meet. A corridor records its geometry and, per pattern, the direction it runs and how far along its shape it enters (5,083 corridors for TransLink, about 1.5 MB of the plan). Divided roads mapped as two one-way ways are two corridors, one per direction; for zoomed-out views `plan.overviewCorridors` merges them (`mergeCarriageways`): a one-way corridor with another running the opposite way alongside it (within 40 m) moves halfway to it, onto the centreline, and takes on its patterns, so the divided road is one line carrying both directions; where the carriageways spread apart for up to 150 m between stretches side by side (round a bend, like the R4's onto 16th Avenue at UBC), they're paired in proportion to the distance along each, so the line doesn't split into a loop (5,000 overview corridors for TransLink, 1,908 km of road against 2,475 km). Corridors are rebuilt with each plan and have no ids of their own: they refer to patterns by index, and nothing outside the plan refers to them.

**Frequency** (`src/plan/bus-frequency.ts`): buses per hour in the busiest direction, counted from the trips on the date, for the hour around the shown time ("now"), averaged over 06:00–01:00 ("day"), or over 01:00–06:00 of the night after it (`FREQUENCY_WINDOWS`). Trips count by when they run, whichever service day they belong to: each window is looked up in the shown service day and the days either side (trips past 24:00 belong to the day before). A corridor counts a trip when it passes, using the timing of the pattern's trip closest to midday to find when that is; a stop counts the buses stopping there. The map colours counts by the site's frequency bands (`packages/shared/src/frequency.ts`: every 6, 12 or 20 minutes or better, and less often). Corridors and stops count every route. A count costs two binary searches per pattern, so recounting every corridor and stop takes about 10 ms.

## Corrections

Rendered positions come from a layered stack:

```
movement plan (schedule-inferred, dispatched)
  └─ + scenario edits (optional)
      └─ + observations and disruptions (optional, time-stamped, each with a source)
```

Observations (`src/corrections/types.ts`) reference **service date + GTFS trip_id**, or **stop + time**, never inferred run ids, which change between builds. Kinds: a sighting at a platform (optionally with a consist), a delay, a cancellation, a consist, a position, and parked trains. The file format and validation rules are in `config/regions/metro-vancouver/observations/README.md` (`src/corrections/validate.ts`). Where they're stored and reviewed is in [docs/DESIGN.md → Corrections and previews](../../docs/DESIGN.md#corrections-and-previews).

- **SkyTrain** observations go through the [dispatcher](#dispatcher): `railInputs()` (`src/corrections/reconcile.ts`) matches them to runs as anchors (a stop at a time), cancellations, consists and parked trains, and the date is re-dispatched centrally, so corrected trains stay consistent with signalling and the trains around them. The result is a patch per date. Browsers never reconcile rail observations.
- **Timetable vehicles** (SeaBus, WCE, buses without real-time data) use a simpler reconciler, `reconcileScheduled()`, in the browser: a sighting shifts its trip (linearly between several sightings), and the terminal layover stretches to the next trip's corrected departure. A consist or vessel name applies to the whole GTFS block.
- Cancelled trips are hidden while their train runs them (the train still runs, empty, in the simulation).
- Positions within 90 s of an observation are *observed*; spans whose times differ from the base plan by ≥ 5 s are *interpolated*.
- The bus RT history is effectively the first observation source, using the same ideas in a simpler form. A future rail real-time adapter should emit `Observation`s rather than touch playback.

## Scenarios

A scenario is a directory in `config/regions/metro-vancouver/scenarios/<name>/` (format in its README; `src/scenario/`):

- `infrastructure.json`: a diff against the base graph: future OSM track, custom GeoJSON track, removals. `composeNetwork` rebuilds base + future + custom track by shared coordinates, with the same code as the OSM import.
- `service.json`: either the base GTFS or service operations (e.g. `extend` a line) that produce a modified plan without mutating the base (it's `structuredClone`d).
- optional config overrides for kinematics, fleet caps and turnback times.

`npm run scenario -- <name>` runs the whole pipeline (apply the diff → validate → generate trips → infer runs → route → dispatch) and writes `var/public/data/regions/metro-vancouver/scenarios/<name>/` (gitignored); `?scenario=<name>` shows it. Buses in scenarios are schedule-only. There's no editing UI, and recomputes stay central: browsers don't run the pipeline. The demo is `broadway-subway`.

## Disruptions and alerts

**Why:** planned SkyTrain disruptions are published only as GTFS-RT **alerts**. They aren't in static GTFS (normal service_ids stay active) and there are no SkyTrain trip updates. For example, Canada Line maintenance on 2026-09-27–30: "Trains will single-track between Bridgeport Station and Richmond-Brighouse Station" from 9 or 11 PM, with reduced headways. The regular timetable can't run on a single track (opposite-direction trains are scheduled in the section 4–5 times an hour), and riders see every train board at one platform.

**What an alert gives us:** structured: route, informed stops (the platform stop_ids of the affected section), cause `MAINTENANCE`, effect `REDUCED_SERVICE`, exact active periods. Free text only: the operating change ("single-track between X Station and Y Station"), headways per section ("Waterfront Station - Bridgeport Station - 10 minutes"), and notes such as "last trains will depart … approximately 5 minutes later".

**How it works:**

1. **Record alerts.** The leader polls `gtfsalerts` within the budget and records SkyTrain, SeaBus and WCE alerts with when each was first and last seen.
2. **Draft** (`src/disruption/alerts.ts`): "single-track(ing) … between X Station and/& Y Station" (within one sentence, e.g. "single track service will be in effect between"), "board all trains from Platform N (at both stations)" and "X Station - Y Station - N minutes" become a draft disruption, pre-filling the open platform when the alert names it. Other alerts (elevators, fares, the Braid arrangement, LIM rail replacement) are listed as unparsed in `/admin`. The leader restores the last recorded alert set (the end of `alerts.ndjson`) when it starts, so that list isn't empty until the first alerts poll.
3. **Confirm**: a person confirms the draft, because alerts don't say which track stays open. Manual disruptions use the same format (`config/regions/metro-vancouver/disruptions/README.md`).
4. **Apply** (`src/disruption/apply.ts`): for `singleTrack`, follow the track through the kept platform, pin the section's intermediate stops to it, close the other track between the two stations (their own platform tracks stay open, so trains can reach the crossovers) and move the period's trips onto cloned patterns routed with the closure. `headway` cancels trips closer together than `minS` per direction. When single-tracking comes without a headway, through service is thinned to `dispatch.singleTrackHeadwayS`, standing in for the short-turns operators add. The date is then re-inferred (turnbacks and yard moves in the period route around the closure too) and [dispatched](#dispatcher); single-track working falls out of the section rules. Because runs and patterns change, the patch carries the whole day's plan, plus notices the site shows ("Service change" badge, and on the affected trains).

Canada Line on 2026-09-28 (a weekday): 66 of 603 trips late by ≥ 30 s (p95 177 s), and no use of the closed track in the period. At full evening service a single-tracked Expo section gridlocks unless thinned (`singleTrackHeadwayS`, a guess).

## Dispatcher

**Why.** Each train's position comes from the timetable independently of every other train, so without a dispatcher nothing stops two trains occupying the same track: ~1,100 conflicting pairs on a weekday, mostly terminus berths, some head-on meetings on track used both ways. Corrections and disruptions such as single-tracking can't be shown credibly without a model of who waits for whom.

**What.** The dispatcher (`src/dispatch/`) turns inferred runs into a feasible movement plan by simulating SkyTrain's signalling. It's the one place where the timetable, infrastructure state, service changes and observations meet:

```
dispatch(plan, runs, graph, inputs) → movement plan + per-train delays, holds and provenance spans
inputs = { closures, serviceChanges, anchors }      // all optional, each with a source and active period
```

- **Deterministic:** the same inputs give byte-identical output (stable ordering, no wall clock, no randomness). Tested.
- **Central only:** it runs at build time (base plans, scenarios, dates with corrections: `build:movements`, `build:dispatch`) and in the server (live). Browsers never dispatch; they download results, so every visitor sees the same plan. Client requests never trigger a dispatch; only new inputs and the build do. A patch only fits the build it was dispatched against (`baseBuiltAt`).
- **Playback stays pure:** positions = f(plan, dispatch result, t). The dispatcher steps through time internally; the ban on frame-stepped state applies to playback.

**Signalling model.** SkyTrain uses moving-block CBTC (believed to be Thales SelTrac on all three lines; OPEN-QUESTIONS #26). Parameters are in `config/regions/metro-vancouver/dispatch.json`, all guesses.

- **Moving block:** a train's movement authority ends a safety margin behind the rear of the train ahead on its path, and the train brakes to stop short of it. Following trains close up and queue naturally.
- **Sections** come from revenue use: track trains in service run both ways (single track, stub platforms), plus crossovers, tails, pockets, sidings and leads. A train may enter one only when its route through to the next place it can clear is free and not reserved by an opposing train. This prevents head-on meetings: a train never enters a single-track section it can't leave. Elsewhere, an empty move running against the normal direction of traffic reserves the pieces it runs "wrong road", and other trains treat that reservation as a stop.
- **Junctions and crossings:** a conflicting route is granted to one train at a time. The train timetabled first at the conflict point goes first, and trains in service go before empty moves. A junction is locked, or a section entered, only if the whole train fits beyond it (*room to clear*); nobody stops on a junction inside another train's reserved section.
- **Crossing moves:** a train may cross a piece another train has reserved in the opposite direction if it will clear `crossingBufferS` before that train could get there (Millennium trains crossing the shared piece at Lougheed while Expo trains are on the Braid single track).
- **Berths:** a stub terminus admits a train only into a free berth. Terminus overlaps become queues outside the station, or surplus trains return to the yard.
- **Yards** are outside signalling (manual operation): only their leads are checked. A pull-out appears only where its body is clear, on no one else's reservation and fouling no junction in use.
- **Never early:** a train doesn't leave a stop before its timetabled time. Lost time is recovered only from timetable slack (the re-timing range and layovers).
- **Resource order** keeps the plan deadlock-free: trains take junction locks and sections only in path order, only when they can reach them, and not beyond their next stop (except track their body will cover there). Junctions beyond the current limit are given back. A section isn't reserved through a junction locked by a train that can no longer stop short of it (one that still can stops for the reservation and gives the junction back). A deadlock breaker exists as a last resort; a "deadlock broken" line in `validate:plan` is a bug to look at.

**Simulation.** A fixed 1 s step over the service day, with all trains of a fleet group together (`src/dispatch/sim.ts`). Each step grants routes, computes authorities and advances trains within their kinematic limits. What each train occupies, reserves and locks, and the authority that follows, is the interlocking's (`src/dispatch/interlocking.ts`): its methods return what refused a request and the train in the way, so it's tested on its own. The trace is compressed back to movement events: trips on time (within 0.5 s) stay by reference; others carry `times`, `waits` (with the reason, e.g. "waiting for the Braid–Sapperton single track") and, where they left the planned profile, `via` (the simulated trajectory, thinned to 2 m), which playback follows. A weekday file is 2.4 MB, 0.64 MB gzipped.

**Inputs** (typed and validated, each with a source and an active period):

- **`closures`:** track out of service, from [disruptions](#disruptions-and-alerts), in the same diff format as scenario infrastructure.
- **`serviceChanges`:** cancelled trips, short-turns, and replacement headways for a section. What operators do when capacity drops is set by config until it's observed.
- **`anchors`:** [observations](#corrections). A sighting pins a train to a stop at a time. The dispatcher absorbs the difference before the sighting (a hold at an earlier station, or early running within slack) and propagates knock-on delays through the signalling.
- **Provenance:** trains within 90 s of an anchor are *observed*, trains whose times the dispatcher changed are *interpolated*, the rest *estimated*.

**Live dispatch** ([apps/server](../../apps/server/README.md#live-dispatch-and-previews)): the leader re-dispatches dates whose observations or disruptions change, in the background (the simulation yields to the event loop). Output is a versioned patch of the runs that differ from the static base plan; versions are content hashes of the inputs, so re-checking unchanged inputs costs nothing. The live endpoint ([apps/server → Live endpoint](../../apps/server/README.md#live-endpoint)) carries the current version per date, and clients fetch `/rt/dispatch/<date>/<version>.json` (immutable) when it changes. Every version is kept, so an "as known then" view is possible later. If the dispatcher or server is down, clients use the static base plan, marked *estimated*.

**Measured:** a full weekday (~2,100 SkyTrain trips, ~225 runs) takes 4–6 s in Node; a changed date is a full 3–5 s re-dispatch (there are no checkpoints). On weekdays (feed 26SEP_20260925), added delay p95 is ≈ 1 minute on the Canada Line, ≈ 20 s on the Expo Line and ≈ 3 minutes on the Millennium Line; ≈ 0 on weekends.

**Run inference changes found through the dispatcher:** turnbacks run at their own speed factor (0.8; at 0.55 the 4-minute Production Way turnaround was infeasible, parking trains on Millennium platforms for 16 minutes), and stub termini send surplus trains to the yard when their berths are full. Pull-outs and pull-ins were first routed by plain shortest path, which ran them against traffic over ~74 km of main line; the penalty brought that to ~5 km.

**Debugging:** `npm run build:movements -- --no-dispatch` writes the timetable-only plan for comparison. `DISPATCH_DEBUG=1` prints the first deadlock's waits-for chain; `DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>` traces one train's state and authority decisions. The builds and the server read these (`packages/data/src/dispatch-debug.ts`) and pass them to the engine as `DispatchOptions.debug`: transit-core itself reads no environment.

## SeaBus AIS

TransLink publishes no real-time data for the SeaBus, but the vessels broadcast AIS. [aisstream.io](https://aisstream.io/documentation) streams it free over a WebSocket, filtered by MMSI and bounding box. Its key stays on the server, and there's no SLA and no history, so we record our own. Settings are in `config/feeds/translink/feed.json` → `ais` (OPEN-QUESTIONS #27).

- **Ingest** ([apps/server](../../apps/server/README.md#real-time-service), `rt/ais.ts`): the leader keeps one WebSocket open (reconnecting with backoff) for the fleet's MMSIs, keeps two days of fixes in memory, and records them in batches every 10 s (database, and `var/ais-history/<feed>/YYYY-MM-DD/HH.ndjson.gz`). Each fix keeps its batch's time. A service date's fixes recorded so far are its day file (`GET /regions/<id>/days/<YYYYMMDD>/<feed>/ais`, complete through `to`), shared by every visitor; the live endpoint carries the batches of the last few minutes, by the same batch times, so a browser continues the day file with them without a gap. Bursts arrive out of time order, which is why both count by batch time rather than fix time.
- **Matching** (`src/ais/match.ts`, pure): each fix matches the trip whose berth-to-berth path it lies on (within 200 m, course within 60° of the path) and whose timetable is nearest (±10 minutes). A moving fix anchors the trip ("here at t"); a docked fix only moves the timetable if it contradicts it (still docked after departure, or docked before arrival). Lateness carries into the vessel's next trips, less layover slack beyond a 90 s turnaround. Each block takes the name of the vessel with the most fixes on it. Fixes that match nothing (the layup berth, the spare) are ignored, so out-of-service vessels stay hidden.
- **Display** ([transit-map](../transit-map/README.md), `ais.ts`): the browser loads the day files of the dates shown and, near now, adds the live window's fixes; it runs the matcher and passes the result to the schedule engine as `ScheduleCorrections`, like sightings. Vessels are drawn on our lanes, shifted to agree with the fixes: observed within 90 s of a fix, interpolated between, carried (estimated) after. Manual observations take precedence.
- **Smoothing** (`src/ais/glide.ts`, like buses' glide): when new fixes arrive, each vessel glides from where it was drawn to where the new corrections put it instead of jumping: drawn behind, it catches up at up to 4 m/s extra over 3–30 s; drawn ahead, it holds (≤ 90 s). Under 5 m nothing changes; over 400 m (or across trips, other than leaving the dock) it jumps. The glide applies only to display times in its window; elsewhere every fix is used (hindsight), so replays interpolate between fixes and never jump.
- **Why anchors, not raw positions**: fixes arrive irregularly from volunteer receivers (per vessel in service a median ~60 s apart, p90 2–3 minutes, max ~4 minutes). Anchoring the timetable degrades gracefully to "schedule + known delay" instead of freezing or jumping.
- **Berth pair of the day**: when a day's docked fixes are mostly (≥ 2, more than all others together) at another pair's berths, the matcher sets `ScheduleCorrections.shapes`, and the engine draws that whole day along the other pair's paths (distance scaled, timing unchanged). Route lines show the day's pair solid and the other dotted.
- **Tools**: `npx tsx pipelines/probe-ais.ts` records raw messages and summarises the feed; `npx tsx pipelines/eval-ais.ts [date]` reports matches, lateness, vessels per block and the berths used.

## Validation

- **Unit tests** (vitest, `test/`): service-day resolution and time parsing, feed selection across overlapping feeds, routing with turns, playback continuity, bus provenance at coverage edges, dispatcher determinism, no deadlock on single-track and stub fixtures, the Braid case (a northbound short-turn waits at the crossover for the departing one), disruptions, alert parsing, SeaBus berths, scenarios, bus RT, and observed stop times and statistics.
- **`npm run validate:infra`** (`pipelines/validate-infra.ts`): every rail platform `stop_id` maps to exactly one platform, every consecutive stop pair in every trip is routable, every terminus has a legal turnback, every yard is reachable, no dangling nodes, and the diagram checklist (`infrastructure/diagram-checklist.json`) is satisfied. It also flags in-service track tagged construction or disused in OSM.
- **`npm run validate:plan`** (`pipelines/validate-plan.ts`): no teleports between movements (fails), conflicts outside yards, delay added against the timetable per line (median, p95, the worst trips and where they waited), holds by place, broken deadlocks, and fleet in service per line.
- **Debug view** (`?debug=1`): segment ids and platform markers on the map.
- CI runs both validators on a pinned GTFS snapshot (`FIXTURE_FEED_DATE` in `.github/workflows/checks.yml`).
