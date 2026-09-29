# SkyTrain Viz: Implementation Plan

Status: **implemented through M7** (2026-09-25). Operations questions still open are tracked in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md). They refine config values and don't block anything.

## Implementation status

| Milestone | State | Notes / deviations from the plan below |
|---|---|---|
| M0 scaffold + timetables | ✅ | Feed discovery, per-feed plans, manifest, service-day resolver (DST-safe). |
| M1 first light | ✅ | Vehicles are drawn by a small WebGL custom layer, not deck.gl: deck.gl's MapLibre integration breaks on maplibre-gl v6. |
| M2 RT service | ✅ | One poller per machine (lock file with follower forwarding), hourly NDJSON recorder, coverage index, live/recorded/estimated provenance. |
| M3 track graph | ✅ | Platforms are mapped by global optimisation (route consistency, distinct tracks, feasible turnbacks), not nearest-track. Two Canada Line Waterfront platforms are pinned by override. The closed Braid–Lougheed Expo track (OMC4 works) is excluded, and Braid short-turns are pinned by role-based rules (OPEN-QUESTIONS #17, #20). |
| M4 trains on tracks | ✅ | SkyTrain trips are re-timed within GTFS minute rounding. Trips are chained FIFO (GTFS blocks only where they're physically continuous). Stub-berth allocation. Known limitation: terminus overlaps at peak and pull-out interference, reported by `validate:plan` (OPEN-QUESTIONS #21–22). |
| M5 Canada Line | ✅ | Came with M3/M4: the graph covers all lines, including Capstan and the Bridgeport OMC. |
| M6 corrections | ✅ | Observations reference service date + trip, or stop + time. Delays are absorbed at layovers. Cancellations, consists and provenance are shown. |
| M7 scenarios | ✅ | Future OSM track, custom GeoJSON track, `extend` service operation. Demo: `broadway-subway`. |
| M8 dispatcher | ✅ | §4.11. **M8.5 alerts ✅**: the RT service polls TransLink alerts every 5 min, drafts disruptions for single-tracking and headway phrases (`data/disruptions/drafts/`, pre-filling the open platform when the alert names it), and `npm run disruptions` lists, confirms or discards them; the Sep 28–30 Canada Line and Sep 28 Expo Line (Edmonds–Royal Oak) works are confirmed from real alerts. Known: at full evening service a single-tracked Expo section gridlocks unless thinned (`singleTrackHeadwayS`, a guess); Sep 28 still breaks 25 waits (pull-ins reversing into wrong-road running at Production Way–University). **M8.4 live ✅**: the RT service's leader re-dispatches dates whose observations or disruptions change (checked every 30 s), keeps every version in `data/dispatch-history/`, advertises current versions in `/rt/live` and serves immutable patches at `/rt/dispatch/<date>/<version>.json`; the app prefers them to the static patches. No checkpoints yet: a changed date takes a full 3–5 s re-dispatch, in the background (the simulation yields to the event loop). **M8.3 disruptions ✅**: `data/disruptions/*.json` (single-track sections, reduced headways) re-plan and re-dispatch their dates; first case: Canada Line Bridgeport–Richmond-Brighouse, Sep 27–30 nights. **M8.2 anchors ✅**: SkyTrain observations re-dispatch their date centrally (`build:dispatch` → per-date patches the app loads); browsers no longer reconcile rail. **M8.1 core ✅**: `build:movements` dispatches every base plan (moving block, junction locks, sections, stub berths). Conflicting pairs per weekday 1,124 → 1 (a broken deadlock); added delay p95 ≈ 3 min on weekdays, ≈ 0 on weekends. Known: 1–2 deadlocks after midnight on weekdays (pull-ins near Edmonds/Lougheed), resolved by the breaker; 4–6 s per service day (budget 1 s). |
| M9 SeaBus AIS | ✅ | §4.12. Live vessel positions from aisstream.io anchor the SeaBus timetable: names per block, delays, observed positions. Recorded to `data/ais-history/`. |
| Public deploy | ⏳ | Not started (Cloudflare Worker + Durable Object poller, R2 for tiles/history). |
| Service alerts → schedule overrides | ✅ | Via M8.3/M8.5: alerts become draft disruptions a person confirms (§4.10). |

## 1. Goal

A web page with a zoomable, to-scale, vector map of Metro Vancouver that animates:

- **SkyTrain** (Expo, Millennium, Canada Lines): every train, on the correct track, through switches, pocket tracks, and turnbacks, and moving to and from the Operations & Maintenance Centres (OMCs) and storage yards as trains enter and leave service. Positions are **inferred from the schedule**.
- **SeaBus** and **West Coast Express**: inferred from the schedule, with simpler geometry (GTFS shapes).
- **Express buses 99, R1–R6**: real positions from GTFS-realtime when live or when recorded history exists, schedule estimates otherwise. Every vehicle shows whether its position is **observed** or **estimated**.

It plays in real time by default and can pause, rewind, fast-forward, and jump to any date in the current or any future published timetable. The architecture needs to support three later additions:

1. **Corrections**: feeding in observed or ground-truth data (real-time rail feeds if they ever exist, manual observations, consist and car numbers).
2. **Infrastructure scenarios**: alternate track layouts (new crossovers, pocket tracks, extensions such as UBC or Surrey–Langley).
3. **Service scenarios**: alternate service patterns on existing or scenario track.

Scenarios are edited as config files. There is no editing UI.

**Decisions made:**

- MIT license
- local-first; static hosting plus a Cloudflare Worker later for the public version
- OpenStreetMap geometry is OK
- MapLibre GL JS with a PMTiles vector basemap
- plain TypeScript
- desktop-first but usable on phones: map plus time slider, minimal chrome

## 2. What the data actually gives us (verified 2026-09-25)

### TransLink GTFS static (feed `26SEP_20260925`, valid 2026-09-07 → 2027-01-03)

| Fact | Implication |
|---|---|
| Rail `stop_times` use **platform-level stops** (e.g. `Waterfront Station @ Platform 2`), with parent stations `999xx`. Capstan (`99959`) is present. | Trips are pinned to specific tracks at every station. This is the key input for track-level placement. |
| Some Canada Line termini use a non-platform stop (`Richmond-Brighouse Station @ Canada Line`). | The platform must be inferred there. |
| Scheduled arrival equals departure at rail stops (zero dwell in the data). | Dwell is modeled from config. |
| Rail trips include short-turns (Production Way, Braid, New Westminster, Lougheed, Bridgeport) and oddities (Expo trips ending at Lougheed P2; Millennium trips from Lougheed P3). | These trips reveal where turnbacks and pocket tracks are used. |
| `block_id` chains trips, but Expo has 133 weekday blocks with gaps. That's far more than the real fleet in service. | **Blocks are not physical trains.** We need train-run inference (§4.3). |
| Weekday rail blocks start and end mostly at termini: Expo at King George (33), Waterfront (30), Production Way, Braid, and Edmonds (27, next to OMC 1); Millennium at Lafarge Lake–Douglas (50 of 89); Canada at Bridgeport (12, next to its OMC). | OMC and yard moves are **not in GTFS**. They're modeled as deadheads (§4.3), with overnight layup practice as config. |
| Service IDs: `1` = weekday, `2` = Sat, `3` = Sun/holiday, plus supplementary IDs added via `calendar_dates` (e.g. `1101` = extras Mon–Thu, not Fri). Holidays remove `1`. | Resolve `activeServices(date)` properly. Never hardcode weekday/weekend. |
| Times go past 24:00 and have leading spaces (`" 5:05:00"`). `shape_dist_traveled` is in km. | Parser details. |
| West Coast Express: 10 trips per weekday (5 each way), no weekend service. SeaBus: 8 blocks. | Both are simple. |
| The undated URL `gtfs-static.translink.ca/gtfs/google_transit.zip` serves the same file as the dated `History/<date>/` snapshot. | This makes detecting new or future timetables easy (§4.2). |
| Route IDs today: Expo `30053`, Millennium `30052`, Canada `13686`, WCE `6770`, SeaBus `6771`, 99 `6641`, R1 `37808`, R2 `38311`, R3 `37809`, R4 `37810`, R5 `37807`, R6 `46604`. | Route IDs can change between feeds. Select routes by name. |

### TransLink GTFS-realtime

- The v3 endpoints (`gtfsrealtime`, `gtfsposition`, `gtfsalerts`, `?apikey=`) work with our key.
- They cover **buses only**. There are plenty of entities for our routes (with vehicle IDs), and zero for SkyTrain, SeaBus, or WCE.
- The endpoints send **no CORS headers**, so they must be proxied, which also keeps the key secret.

### OpenStreetMap (Overpass query, 2026-09-25)

OSM maps SkyTrain **per track** in detail:

- 264 `railway=switch` nodes
- 45+ crossovers
- named pockets: Metrotown, Vanness, Holdom, Moody Centre, Great Northern, "Mainline Pocket", Waterfront Tail
- yard tracks: **Canada Line OMC** (~50 tracks, east of Bridgeport), **OMC 1** (~75 tracks across two clusters, south of Edmonds), and a **~16-track yard near Inlet Centre/Coquitlam Central**

OSM becomes our primary source for geometry *and* topology.

### Wikipedia track diagram v3 ("Mid-2021")

- It labels the OMC leads: **"To OMC"** between Edmonds and 22nd Street (Expo/Millennium), and **"To OMC"** at Bridgeport (Canada Line).
- It also notes "an extra storage facility in Coquitlam" ("east of Falcon Drive").
- It predates Capstan.

It's used as an independent checklist to validate the OSM-derived graph. It doesn't provide geometry.

## 3. Architecture overview

```
                  BUILD TIME (Node/TS scripts)                          RUNTIME (browser)
 ┌───────────────┐   ┌─────────────┐   ┌──────────────────┐   ┌─────────────────────────────────┐
 │ GTFS static   │──▶│ ingest/     │──▶│ service plan     │──▶│ Clock (t, rate, date)           │
 │ (every feed   │   │ filter/     │   │ per feed version │   │        │                        │
 │  version)     │   │ normalize   │   └────────┬─────────┘   │        ▼                        │
 └───────────────┘   └─────────────┘            │             │ Position engine:                │
 ┌───────────────┐   ┌─────────────┐            │ run         │  f(movements, t) → vehicles     │
 │ OSM (Overpass)│──▶│ import +    │──▶ track ──▶│ inference + │  each with provenance           │
 └───────────────┘   │ hand fixes  │    graph   │ routing     │        ▲                        │
 ┌───────────────┐   └─────────────┘            ▼             │        │ overlays               │
 │ Scenarios     │──────────────────▶ ┌──────────────────┐    │  corrections · bus RT · history │
 │ (config diffs)│                    │ movement plan    │───▶│                                 │
 └───────────────┘                    │ per service day  │    │ MapLibre GL (PMTiles basemap)   │
                                      └──────────────────┘    │  + vehicle layer                │
                                                              └──────────────┬──────────────────┘
                                                                             │ /rt/live, /rt/history
                                               ┌─────────────────────────────▼──────────────────┐
                                               │ RT service (local Node; later CF Worker):      │
                                               │  single upstream poller → shared cache → CORS  │
                                               │  + recorder → hourly snapshot files            │
                                               └────────────────────────────────────────────────┘
```

The core design principle is that **every vehicle position is a pure function of (movement plan, overlays, time)**. Nothing steps a simulation forward frame by frame. That makes seeking, rewinding, and 1000× fast-forward trivial and deterministic, and it makes corrections and scenarios composable, because they just produce a different plan or overlay. The dispatcher (§4.11) keeps this: it runs centrally (build time, RT service), and its output is one more versioned plan that playback reads.

Every vehicle state carries a **provenance** field (`observed | interpolated | estimated`) and a `source`. The same concept drives the bus real-vs-estimated indicator and, later, rail corrections.

## 4. Components

### 4.1 Infrastructure model (the track graph)

This is the heart of the project. It lives as versioned data in `data/infrastructure/`, not in code.

**Entities**

- **Track segment**: an id, a WGS84 polyline, a line/corridor tag, a computed length, an optional speed profile, and a kind: `main | pocket | tail | crossover | yard | lead`.
- **Node**: kind `switch` (with explicit allowed leg pairings, so routes can't reverse through a frog), `buffer` (end of track), or `link`.
- **Platform**: a span on a segment, plus the GTFS `stop_id`(s) it serves (e.g. `8039` = Waterfront P2) and a stopping point.
- **Yard**: a polygon, its storage tracks, capacity, and **access points** where leads join the mainline:
  - `omc1` (Edmonds): Expo/Millennium
  - `coquitlam` (storage near Inlet Centre/Coquitlam Central): Millennium
  - `omc-canada` (Bridgeport): Canada Line

  Yard tracks come from OSM at full detail. The renderer can simplify them at lower zooms.

**Sourcing pipeline**

1. `scripts/fetch-osm.ts` runs an Overpass query for `railway=subway` ways plus `railway=switch` nodes in the Metro Vancouver bbox. Output goes to `data/raw/osm/` with a timestamp.
2. `scripts/import-osm.ts` converts OSM into our graph format: splits ways at switches and shared nodes, classifies segments from `service=*` and `name`, and emits `data/infrastructure/tracks.generated.geojson`.
3. **Hand fixes** live in `data/infrastructure/overrides.json`: platform↔stop_id mapping, switch pairings OSM doesn't encode, corrections, and yard metadata. They're applied on top of the import, so OSM can be re-pulled without losing the fixes.
4. The validator (§7) checks the result against GTFS (every platform and stop pair routable) and against a hand-written diagram checklist (`data/infrastructure/diagram-checklist.json`: every crossover and pocket from the Wikipedia diagram, plus Capstan).

**Rendering at scale**

- Parallel tracks are about 4 m apart. At city zoom that's sub-pixel, so we render one line per corridor, with a small pixel offset per track.
- At station zoom (z ≥ 15–16) we render true geometry, switches as diverging lines, and platforms as rectangles.
- When zoomed in, trains are drawn to scale as a chain of car polygons following the track curvature. Zoomed out, they're fixed-size markers.

### 4.2 Timetables (GTFS → service plan)

Scripts: `scripts/fetch-gtfs.ts` and `scripts/build-schedule.ts`.

- **Feed discovery**: fetch the undated `google_transit.zip` and read `feed_info.txt` (`feed_version`, `feed_start_date`, `feed_end_date`). If the version is new, archive it to `data/raw/gtfs/<feed_version>/` and build it. Previously built versions are kept (cheap), and there's no backfill of historical feeds. Run this on demand locally; later, on a schedule.
- **Manifest**: `public/data/manifest.json` lists the feed versions with their validity ranges. `feedFor(date)` picks the newest feed whose range covers the date. That handles "current plus future timetables", including a newer feed superseding the tail of an older one. The date picker is bounded by the union of the ranges.
- **Filter** to the target routes **by name**: 3 SkyTrain lines, SeaBus, WCE, 99, R1–R6.
- **Normalize** into a compact service plan per feed version:
  - trips, each with route, direction, headsign, service_id, block_id, shape_id, and `(stop_id, arr, dep)` in seconds since service-day start
  - stops with platform→parent mapping
  - simplified shapes
  - calendar and calendar_dates
- **Service-day resolver**: `activeServices(date)` applies calendar ranges, weekday flags, and add/remove exceptions. Trips after 24:00 belong to the previous service day.

### 4.3 Train-run inference (schedule → physical trains)

Script: `scripts/infer-runs.ts`. This is where the "best guess" lives, so it should be explicit, configurable, and replaceable.

For each SkyTrain line and each distinct service-day pattern:

1. **Chain trips into runs.** At each terminus, match arriving trips to departing trips (min-cost matching). Constraints:
   - same line
   - arrival platform can reach the departure platform through a legal turnback in the track graph (e.g. arrive at King George P2, reverse on the tail track, depart P1)
   - layover ≥ the configured minimum for that terminus

   `block_id` is a tiebreaker hint only.
2. **Pull-outs and pull-ins.** A run's first trip gets a pull-out from a yard (or from an overnight layup position, if config says trains lay up on tail or pocket tracks). Its last trip gets a pull-in. Yard choice comes from config per line and origin, defaulting to nearest by graph distance.
3. **Peak build-up and withdrawal.** When the matcher needs a new train mid-day, it pulls one from a yard. When service thins, it sends one back. These are the trains the map shows entering and leaving service.
4. **Consist placeholder.** Each run gets `consist: { type?, cars?, carNumbers? }` from per-line defaults. It's usually "unknown", and it's the hook for future car-number data.

Output: **runs**, each an ordered list of movements (revenue trips and deadheads).

### 4.4 Movement plan and routing

Script: `scripts/build-movements.ts`. The same code builds scenarios, and it will feed the dispatcher (§4.11).

- **Routing**: each leg (platform → platform, yard → platform, turnback) is routed on the track graph by shortest path, respecting switch pairings. Legs start and end on the specified platform's track.
- **Timed paths**: each leg becomes a list of `(edgeId, fromOffset, toOffset)` plus a time profile. Per-line kinematics (accel, decel, top speed, dwell; all in config) are fitted so run time matches the schedule. Slack goes into the dwell.
- **Conflict check** (validation only): flags two runs occupying the same track span at once. This catches modeling errors early and infeasible scenarios later. The dispatcher (§4.11) will prevent conflicts instead of only reporting them.
- **Runtime**: `positionAt(run, t)` binary-searches the timed path, applies the kinematic interpolation, and maps the edge offset to lat/lon plus bearing.

### 4.5 SeaBus, West Coast Express, and buses

- **SeaBus and WCE** are schedule-based, interpolated along GTFS shapes with ease-in/out between stops. Vessels and trainsets are chained by block_id (for SeaBus, a block is one vessel: 2 in service, 3 at weekday peaks, 1 late evening; see OPEN-QUESTIONS #14). Out-of-service vessels are hidden. SeaBus runs berth to berth along keep-right lanes traced from AIS instead of its GTFS shapes: `src/core/plan/ferry-berths.ts`, applied by build-schedule, runs every vessel between the same pair of berths (west–west or east–east, set in `data/config/seabus.json`; OPEN-QUESTIONS #24). Live AIS fixes anchor its timetable (§4.12). No infrastructure model. WCE mid-day and overnight storage is an open question: whether to show parked trainsets at all.
- **Bus route lines** are split by coverage (`src/core/plan/coverage.ts`): sections served by under 25 % of the route's busiest section (e.g. the 99 east of Commercial–Broadway) and sections where no passengers can be aboard are drawn dotted. The latter comes from GTFS `pickup_type`/`drop_off_type` (kept per pattern stop as `access`): e.g. the 99 drops off at Commercial Dr @ N Grandview Hwy (58491), lays over at N Grandview Hwy @ Commercial Dr (58620: no pickup or drop-off) and picks up at Commercial–Broadway Bay 5 (50913). Stops where nobody can board or alight get no marker.
- **Buses (99, R1–R6)** are resolved per vehicle, in priority order:
  1. **Observed**: a live or recorded snapshot position at (or within one poll interval of) *t*.
  2. **Interpolated**: between two observations of the same vehicle less than ~3 min apart, moved along the trip's shape rather than in a straight line.
  3. **Estimated**: scheduled trip interpolation along the shape. This is used when no RT data covers *t*: the recorder wasn't running, future times, or a gap.

  Fixes arrive ~20–60 s old and ~30 s apart, so the live view always predicts (`src/core/rt/profile.ts`, `timeline.ts`):
  - **Travel-time profile** learned from the recorded history (`npm run build:rt-profile` → `public/data/feeds/<v>/rt-profile.json`): pace per 50 m bin along each trip shape by time-of-day band (congestion, signals) and expected dwell per stop. With ~30 s fixes most dwells show up as slow bins around the stop, so slow time within 75 m of a stop (vs the pace nearby) is moved into its dwell; this makes buses visibly stop, at a small cost in average accuracy (a smooth "expected" position is closer on average than a stop-or-go guess). Gaps fall back to the all-day profile, then the timetable's running times with a default dwell, then a default speed.
  - **Prediction** walks the bus forward from its last fix with the profile, stopping at each upcoming stop for its expected dwell (stops behind the fix are passed). A bus whose predicted dwell ends leaves on time even without a new fix (RT reporting gaps are likelier than long dwells; revisit with ground truth).
  - **Corrections glide**: when a new fix becomes known (client receipt live, fetch time when recorded), a bus that turns out further ahead glides forward (≤ 8 m/s faster, ≤ 25 s); one that turns out behind holds still until the prediction catches up, never reversing. Corrections > 600 m snap.
  - Between two known fixes (recorded playback), motion follows the profile scaled to fit both fixes, so stops show there too.
  - **Schedule estimates** for buses (no RT coverage, e.g. fast-forwarding past the live edge) use the same profile between timetable times ≥ 3 min apart, scaled to meet them: the bus stops at each stop and holds at those anchor stops until its timetable time.
  - **Delays carry forward** (`src/core/rt/carry.ts`): each bus's delay against that paced schedule, measured where RT prediction leaves it (fix + 90 s), shifts the rest of its trip; lateness carries into its next 2 trips less layover beyond a 120 s turnaround, early running doesn't. A bus unreported for > 90 s continues as a delay-shifted estimate (unless its block is shown from RT) instead of vanishing, and fast-forwarding past the live edge keeps every known delay. Hand-over from RT to estimate: median 8 m, p90 14 m (measured in the app at 10×). Positions stay provenance *estimated*.
  - Predictions are *interpolated*, not *observed* (only within 10 s of a fix). Implausible fixes (null island, > 45 m/s jumps) are dropped.
  - **Standing and layovers**: a bus never moves backwards along its trip. A fix behind the furthest point reached (≤ 150 m) holds it there, standing; lone spikes ahead that the next fix contradicts are dropped. **Between trips** (before its trip's scheduled departure, or a late start that hasn't left its first stop or layover spot) a bus is drawn only at its next trip's first stop (on the route, within 100 m along it), standing and facing along the route with a "Between trips" note and no delay; elsewhere (GPS off route, repositioning) it isn't drawn until it starts the trip. In recorded playback a bus whose next fix is hidden stands where it was rather than being predicted on.
  - **Shifted GPS**: some buses report positions offset hundreds of metres from where they are (seen 2026-09-26: an R4 and a 99 ~350–620 m north of their routes for 30+ min, on time; TransLink's stop matching stalls on such buses, so its next stop stays at stop 1 and its delay grows by 30 s every 30 s). Fixes 150 m–1 km off the trip's shape are placed on the route at their along-route position when they progress plausibly from the last placed fix (≤ 15 m/s, steady offset) or fit the timetable (± 20 min); they're *interpolated* and noted in the inspect panel. When TransLink's next stop is > 200 m behind the bus, next stop and delay come from the position instead. Fixes that can't be placed (e.g. buses going to/from the depot, > 1 km off) are shown as reported with a note and no delay. Recorded data: 98.7 % of fixes within 50 m of their shape, 0.2 % 300 m–1 km (mostly those two buses), 0.2 % > 1 km (mostly null-island fixes).
  - **Service changes** (`src/core/rt/changes.ts`, OPEN-QUESTIONS #28): TransLink publishes cancellations as trip updates (`CANCELED`) and as "no service" alerts naming the trip. It publishes skipped stops as `SKIPPED` stop time updates, and detours only as alerts: route (maybe direction), affected stops, and the path in words. There's no shape and no `TripModifications`, so detour paths aren't drawn. Cancelled trips get no schedule estimate, carry no delay, and absorb none. A bus still reporting one is drawn from its fixes with a note. A "no service" alert that lists stops is a partial cancellation, so only those stops count as skipped. Skipped stops are never a bus's next stop and get no predicted dwell. A bus off its route within 3 km of a stop named by an active detour alert for its route (and direction) is labelled "On detour" with the alert's text, keeps TransLink's delay, and is never taken for shifted GPS.
  - Evaluate with `npx tsx scripts/eval-rt.ts` (train on older hours, replay the latest as the live view would). On 2026-09-26 (8 h train, 3 h test): median error 30 s ahead 94 → 50 m, 60 s ahead 188 → 70 m; live display error vs fixes 120 → 64 m; jumps when data arrives: median 63 → 0 m, > 50 m in 52 % → 0.6 % of updates.

### 4.6 RT service (proxy + cache + recorder)

This is one small service with two jobs. It runs locally as a Node process (started by `npm run dev` alongside Vite) and later as a Cloudflare Worker with a Durable Object.

**Live proxy, built so it never hammers TransLink**

- **One upstream poller**: a single loop fetches `gtfsposition` (and `gtfsrealtime` for delays) every 20–30 s, regardless of how many clients are connected. Client requests never trigger upstream fetches. They read the latest cached snapshot.
- Decodes the protobuf, filters to our routes, and serves compact JSON at `GET /rt/live`, with `Cache-Control: public, max-age=10` and CORS. In the public version the CDN edge absorbs traffic, and the upstream rate stays constant at ~2–3 req/min per endpoint.
- **Backoff**: on upstream errors it keeps serving the last snapshot, marked `stale: true` with its age. The client falls back to estimates when data is older than ~2 min.
- The key is read from `.secrets` locally, or from a Worker secret in production. It never reaches the browser.

**Recorder**

- Every poll result (already filtered to our routes) is appended to **hourly chunk files**: `data/rt-history/YYYY-MM-DD/HH.ndjson.gz`, one line per snapshot with `{ts, vehicles:[{id, tripId, routeId, lat, lon, bearing?, stopSeq?, status?, delay?}]}`. Size is about a few MB per day.
- `GET /rt/history?date=YYYY-MM-DD&hour=HH` serves a chunk. `GET /rt/coverage?from&to` returns the time ranges where the recorder was running (gaps longer than 2 poll intervals count as uncovered).
- **Service changes**: each trip-updates and alerts poll updates `data/rt-history/changes/YYYYMMDD.json` for our bus routes. It holds cancelled trips and skipped stops per service date, and route alerts with when each was first and last seen. It exists because the feeds forget a trip once it has run and an alert once it's over. `GET /rt/changes?date=YYYYMMDD` serves it, and the client refetches today's and yesterday's every minute.
- The file layout maps directly onto R2 objects for the public version.

**Live dispatch** (§4.11): the same leader process runs the dispatcher. `GET /rt/dispatch` lists the current patch version per service date and `/rt/live` carries the same pointer; `GET /rt/dispatch/<date>/<version>.json` serves a patch (immutable, cacheable forever). Versions are content hashes of the inputs, so re-checking unchanged inputs costs nothing and a restart reloads them from `data/dispatch-history/`.

**Client indicator**

- The time slider shows a thin **coverage strip**: shaded where recorded or live bus data exists, empty where the plan is estimated.
- Vehicle markers render observed and interpolated positions **solid**, and estimated positions **hollow or translucent**.
- A small badge reads "Buses: live", "Buses: recorded", or "Buses: estimated".
- SkyTrain, SeaBus, and WCE always show as estimated until corrections exist. The same visual language will then show corrected runs.

### 4.7 Corrections layer (future-proofing)

Rendered positions come from a layered stack:

```
movement plan (schedule-inferred)
  └─ + scenario edits (optional)
      └─ + observations (optional, time-stamped, each with a source)
```

```ts
type Observation =
  | { kind: 'at_platform'; t: number; stopId: string; runId?: string; consist?: Consist; source: string }
  | { kind: 'delay'; runId: string; fromT: number; seconds: number; source: string }
  | { kind: 'cancel'; tripId: string; source: string }
  | { kind: 'consist'; runId: string; consist: Consist; source: string }
  | { kind: 'position'; t: number; lat: number; lon: number; runId?: string; source: string };
```

SkyTrain observations go through the **dispatcher** (§4.11, M8.2): `railInputs()` matches them to runs as anchors (a stop at a time), cancellations and consists, and the date is re-dispatched centrally, so corrected trains stay consistent with signalling and the trains around them. The result is published as a patch per date. (Until M8.2 a reconciler warped each run's clock at playback.)

- Timetable-based vehicles (SeaBus, WCE, buses without real-time data) use a simpler reconciler, `reconcileScheduled`. A sighting shifts its trip (linearly between several sightings), and the terminal layover stretches to the next trip's corrected departure. A consist or vessel name applies to the whole GTFS block.
- Cancelled trips are hidden while their train runs them (the train still runs, empty, in the simulation).
- Consist data attaches to runs.
- Positions within 90 s of an observation are `observed`; spans whose times differ from the base plan by ≥ 5 s are `interpolated`.

Sources:

- `data/observations/*.json` files
- later, a rail RT adapter if TransLink publishes one

The bus RT history is effectively the first observation source. It uses the same reconciler concepts in a simpler form.

### 4.8 Scenarios (config files)

A scenario is a directory in `data/scenarios/<name>/`:

- `infrastructure.json`: a diff against the base graph (add, remove, or modify segments, switches, platforms, and yards; new segments as GeoJSON)
- `service.json`: either `{ "base": "gtfs" }` or a service-pattern spec that generates trips, e.g. line, pattern (origin → destination, stopping platforms), headways by time band, and short-turn rules
- optional `config.json`: overrides for kinematics, fleet caps, and turnback times

`npm run scenario <name>` runs the full pipeline (apply diff → validate → generate trips → infer runs → route → conflict check) and writes `public/data/scenarios/<name>/`. The app picks scenarios via `?scenario=<name>`. There's no editing UI. Recomputes stay central (build time or the RT service, §4.11); browsers don't run the pipeline.

### 4.9 Frontend

- **Stack**: TypeScript + Vite, plain TS with a tiny reactive store, and **MapLibre GL JS** for all map rendering.
- **Vehicles**: rendered by a small WebGL2 layer (`src/app/layers/gl-polygons.ts`) through MapLibre's public `CustomLayerInterface`. Geometry is built on the CPU each frame (a few hundred to-scale shapes) relative to the viewport centre, and the offset is folded into the matrix in float64, so positions stay precise at station zoom. Picking is also done on the CPU. *(Decision, 2026-09-25: deck.gl's MapLibre integration reads private `map.transform` internals and breaks on maplibre-gl v6, so a dependency-free custom layer is more robust.)*
- **Basemap**:
  - a **PMTiles** extract of the Protomaps basemap, clipped to Metro Vancouver (`pmtiles extract`, maxzoom 15, overzoomed above that), served as a static file with HTTP range requests through the `pmtiles` MapLibre protocol
  - styled with `@protomaps/basemaps` in muted light and dark flavours so transit layers stand out
  - glyphs and sprites hosted locally, so there are no third-party tile or font calls
  - `npm run tiles` builds it into `public/tiles/` (gitignored, roughly 50–150 MB)
  - public-hosting note: Cloudflare Pages has a 25 MB per-file limit, so the PMTiles file will go on R2
- **Time controls**, the only chrome beyond the map, laid out as a bottom bar on desktop and a compact bottom sheet on phones:
  - play/pause
  - speed presets: −60×, −10×, 1×, 10×, 60×, 300×
  - scrub slider across the service day (~04:00 → 02:00 next day) with the bus-coverage strip
  - date picker bounded to the available feeds, showing the service type (e.g. "Weekday (Mon–Thu)")
  - "Live" button
- **URL state**: `?date=&t=&rate=&z=&ll=&scenario=`, so views are shareable.
- **Inspect**: tap or hover a vehicle to see line, run id, current or next trip, next stop, status (in service, deadhead, or in yard), consist (or "unknown"), and provenance. On phones this appears in a small popover.
- **Layer toggles**: a collapsible legend with each line and route, plus debug layers (conflicts, run ids).
- **Performance targets**: 60 fps on desktop and ≥30 fps on a mid-range phone with ~300 vehicles.

### 4.10 Service alerts as dated schedule overrides (done in M8.3–M8.5)

**Why:** planned SkyTrain disruptions are published only as GTFS-RT **alerts**. They aren't in static GTFS (normal service_ids stay active) and there are no SkyTrain trip updates. Verified 2026-09-26 for Canada Line maintenance: "Trains will single-track between Bridgeport Station and Richmond-Brighouse Station" on Sep 27–30 from 9 or 11 PM, with reduced headways. On those nights the app currently shows the regular timetable, which a single track can't carry: opposite-direction trains are scheduled in the section 4–5 times an hour. Riders see all trains board at Lansdowne Platform 1. The long-running Braid/OMC4 arrangement is also announced only by an alert ("temporary platform assignments … between Braid & Lougheed", since 2024-02-25).

**What the alert gives us:**
- *Structured:* route (`13686`), informed stops (the platform stop_ids of the affected section), cause `MAINTENANCE`, effect `REDUCED_SERVICE`, exact active periods.
- *Free text only:* the operating change ("single-track between X Station and Y Station"), headways per section ("Waterfront Station - Bridgeport Station - 10 minutes"), and notes such as "last trains will depart … approximately 5 minutes later".

**Sketch:**
1. **Record alerts.** The RT service already has the key. Poll `gtfsalerts` (slowly, e.g. every 5 min), keep SkyTrain/SeaBus/WCE alerts, and archive them by active period, like the recorder. Past dates keep the overrides that applied then.
2. **Parse to typed overrides.** Formulaic phrases map via tested regexes, and anything unrecognised is kept as "unparsed" and shown to the user:
   - `single-track between A and B` → close one track in that section for the active period (graph edits like scenario infrastructure diffs).
   - `A - B - N minutes` → replace the timetable in that section with a generated N-minute pattern for the period (scenario-style service operation).
   - platform reassignments → role-based pins (like `patternPlatforms`).
3. **Apply per date.** Confirmed overrides become dispatcher inputs (§4.11) for their active period: closures, service changes and platform pins. The RT service re-dispatches the affected dates and publishes them like any other dispatch version. Parsing produces a draft that a person confirms, because alerts don't say which track is closed.
4. **Show it.** A banner or badge when the displayed time has an active alert, the alert text in the inspect card, and provenance "adjusted by TransLink alert" on affected trains.
5. **Hand overrides.** The same format takes manual entries (`data/disruptions/`, M8.3), for disruptions without a parseable alert.

**As built:** steps 1–5 are done. The RT leader polls `gtfsalerts` every 5 min and appends changes to `data/rt-history/alerts.ndjson`; `src/core/disruption/alerts.ts` turns "single-track (in both directions) between X Station and/& Y Station", "board all trains from Platform N (at both stations)" and "X Station - Y Station - N minutes" into a draft; `npm run disruptions` confirms it into `data/disruptions/`. Other alerts (elevators, fares, the Braid arrangement, LIM rail replacement) are listed as unparsed. When single-tracking comes without a headway, through service is thinned to `dispatch.singleTrackHeadwayS` (standing in for the short-turns operators add; generating short-turn trips is future work).

**Open points:**
- Which track is closed when an alert says only "single-track": needs ground truth, as at Braid (the confirm step asks for it).
- How to time the reduced-headway pattern relative to the rest of the line.
- How to treat alerts whose text changes between polls.

### 4.11 Dispatcher: signalling-aware movement plans (planned)

**Why.** Each train's position comes from the timetable independently of every other train, so nothing stops two trains occupying the same track. `validate:plan` reports ~1,100 conflicting pairs on a weekday. Most are terminus berths (Waterfront 324, Production Way–University 226; OPEN-QUESTIONS #21). Some are head-on meetings on track used in both directions. For example, on 2026-09-28 at 10:02:35 two Braid short-turns meet at the crossover south of Sapperton; the real train waits ~30 s there (#20). Corrections make this worse, because `reconcile()` shifts runs at playback, after any consistency check. And disruptions such as single-tracking (§4.10) can't be shown credibly without a model of who waits for whom.

**What.** A dispatcher (`src/core/dispatch/`, DOM-free) turns the inferred runs (§4.3) into a feasible movement plan by simulating SkyTrain's signalling. It is the one place where the timetable, infrastructure state, service changes and observations meet:

```
dispatch(plan, runs, graph, inputs) → movement plan + per-train delays, holds and provenance spans
inputs = { closures, serviceChanges, anchors }      // all optional, each with a source and active period
```

- **Deterministic:** the same inputs give byte-identical output (stable ordering, no wall clock, no randomness). This is tested.
- **Central only:** it runs at build time (static base plans, scenarios) and in the RT service (live). Browsers never dispatch; they download results, so every visitor sees the same plan. Client requests never trigger a dispatch. Only new inputs, and the build, do.
- **Playback stays pure:** positions = f(plan, dispatch result, t). The dispatcher may step through time internally; the ban on frame-stepped state applies to playback.

**Signalling model.** SkyTrain uses moving-block CBTC (Thales SelTrac on all three lines, to verify: OPEN-QUESTIONS #26).
- **Moving block:** a train's movement authority ends a safety margin behind the rear of the train ahead on its path, and the train brakes (config decel) to stop short of it. Following trains close up and queue naturally.
- **Route locking:** a train may enter a section used in both directions only when its route through to the next place where it can clear is free and not reserved by an opposing train. Such sections include single-track working, stubs such as Braid's west track, tail and pocket tracks, and crossovers. This prevents head-on meetings and deadlock: a train never enters a single-track section it can't leave.
- **Junctions and crossings:** a conflicting route is granted to one train at a time. The train timetabled first at the conflict point goes first, and revenue trains go before empty moves (config).
- **Berths:** a stub terminus admits a train only into a free berth. This replaces the berth allocator in `build.ts`. Terminus overlaps (#21) become queues outside the station, or surplus trains return to the yard as now.
- **Yards** are outside signalling (manual operation): only their leads are checked.
- **Never early:** a train doesn't leave a stop before its timetabled time. Lost time is recovered only from timetable slack (the retime range and layovers).

**Simulation.** A fixed time step (1 s) over the service day, with all trains of a fleet group together. Each step grants routes, computes authorities and advances trains within their kinematic limits. The trace is then compressed back to movement events:
- Trips that run on plan stay stored by reference, so files stay small.
- Trips that deviate carry explicit stop times.
- Waits at signals become holds of kind `signal`, which can fall mid-hop.

The existing leg solver reproduces motion between stops. The movement schema goes to version 2.

**Inputs** (typed and validated, each with a source and an active period)
- **`closures`:** track out of service (segment spans), optionally declaring a section as single-track with the crossovers to use. They use the same diff format as scenario infrastructure (§4.8).
- **`serviceChanges`:** cancelled trips, short-turns, and replacement headways for a section (scenario-style service operations, §4.8). What the operator does when capacity drops is set by config policies until it's observed, e.g. cap trains through a single-track section at N per hour and cancel the rest, or short-turn at the nearest crossover.
- **`anchors`:** observations (§4.7). A sighting pins a train to a stop at a time. The dispatcher absorbs the difference before the sighting (a hold at an earlier station, or early running within slack) and propagates knock-on delays through the signalling. This replaces `warp()` for rail; timetable vehicles keep `reconcileScheduled`.
- **Provenance:** trains within 90 s of an anchor are *observed*, trains whose times the dispatcher changed are *interpolated*, and the rest are *estimated*. The inspect panel says why a train is held, e.g. "waiting for the Braid–Sapperton single track".

**Central live dispatch** (the RT service now, its Durable Object in the public version)
- **Input sources:**
  - committed files (`data/observations/`, `data/disruptions/`)
  - confirmed alert overrides (§4.10)
  - later, authenticated observation submissions

  Anonymous visitors can't change the shared model.
- **Re-dispatch:** a new input triggers a re-dispatch of its service date from the earliest affected time. It starts from a checkpoint of the simulation state (saved every 15 min of service time), so nothing before the input changes. The output is a versioned patch: the runs that differ from the static base plan.
- **One dispatch, many subscribers:** `/rt/live`, which clients already poll every ~10–30 s, gains `dispatch: { <date>: <version> }`. Clients fetch `/rt/dispatch/<date>/<version>.json` when the version changes. Patches are immutable and CDN-cacheable indefinitely; the version pointer is cached like `/rt/live` (max-age 10). Server-sent events or WebSockets can replace polling later without changing the model.
- **History:** versions are persisted (on disk now, R2 later). Viewing a past time uses the latest version for that date, which is the best reconstruction. Keeping the earlier versions allows an "as known then" view later.
- **Fallback:** if the dispatcher or the service is down, clients use the static base plan, marked *estimated* as today.

**As built (M8.1).** Details that the design above didn't anticipate:
- *Sections* come from revenue use: track trains in service run both ways (single track, stub platforms), plus crossovers, tails, pockets, sidings and leads. Elsewhere, an empty move running against the normal direction of traffic reserves the pieces it runs "wrong road", and other trains treat that reservation as a stop. (Pull-outs and pull-ins were first routed by plain shortest path, which ran them against traffic over ~74 km of main line; §4.3 now penalises that.)
- *Resource order:* trains take junction locks and sections only in path order, only when they can reach them, and not beyond their next stop (except track their body will cover there). Junctions beyond the current limit are given back. This, rather than cleverness in the deadlock breaker, is what keeps the plan deadlock-free.
- *Room to clear:* a junction is locked, or a section entered, only if the whole train fits beyond it; nobody may stop on a junction inside another train's reserved section.
- *Crossing moves:* a train may cross a piece that another train has reserved in the opposite direction if it will clear `crossingBufferS` before that train could get there (Millennium trains crossing the shared piece at Lougheed while Expo trains are still on the Braid single track).
- *Spawning:* a pull-out appears only where its body is clear, on no one else's reservation and fouling no junction in use.
- *Output:* trips on time stay by reference (within 0.5 s); others carry `times`, `waits` (with the reason) and, where they left the planned profile, `via` (the simulated trajectory, thinned to 2 m), which playback follows. Weekday file: 2.4 MB, 0.64 MB gzipped.
- *Run inference changes found through the dispatcher:* turnbacks run at their own speed factor (0.8; at 0.55 the 4-minute Production Way turnaround was infeasible, parking trains on Millennium platforms for 16 min), and stub termini send surplus trains to the yard when their berths are full (§4.3).
- *Debugging:* `DISPATCH_DEBUG=1` prints the first deadlock's waits-for chain; `DISPATCH_TRACE=<run> DISPATCH_TRACE_FROM=<s> DISPATCH_TRACE_TO=<s>` traces one train's state and authority decisions.

**Disruptions (M8.3).** `applyDisruptions()` turns a disruption into a modified plan for the date: for `singleTrack`, it follows the track through the kept platform, pins the section's intermediate stops to it, closes the other track between the two stations (their own platform tracks stay open, so trains can reach the crossovers) and moves the period's trips onto cloned patterns routed with the closure; `headway` cancels trips closer together than `minS` per direction. The date is then re-inferred (the run builder routes turnbacks and yard moves in the period around the closure too) and dispatched; single-track working falls out of the section rules. Because runs and patterns change, the patch carries the whole day's plan, plus notices the app shows ("Service change" badge, and on the affected trains). Canada Line Sep 28 (weekday): 66/603 trips late ≥ 30 s (p95 177 s), no use of the closed track in the period.

**Budget.** A full weekday dispatch (~2,100 SkyTrain trips, ~150 runs) takes under 1 s in Node, and an incremental re-dispatch under 200 ms. The plan (2.4 MB JSON), graph and checkpoints need well under a Durable Object's 128 MB.

**Validation.**
- **`validate:plan`:** conflicting pairs drop to 0 (outside yards). New reports: delay added against the timetable per line (median, p95, the worst trips and where they waited) and holds by place.
- **Tests:**
  - determinism
  - an incremental re-dispatch equals a full one
  - no deadlock on single-track and stub fixtures
  - the Braid case: a northbound short-turn waits at the crossover for the departing one
- **Field checks** against ground truth, e.g. the ~30 s hold before the crossover south of Sapperton (GPS, 2026-09-27).

**Open points.** These become config values and OPEN-QUESTIONS items during implementation.
- Signalling parameters: safety margin, minimum headway, and whether dwell extends while a train is held (#26).
- Priority at junctions and merges.
- How operators adapt service when a section is single-tracked: short-turns, longer headways or cancellations.
- Whether CBTC trains recover lost time by running faster, or only at layovers.

### 4.12 SeaBus positions from AIS (done in M9)

TransLink publishes no real-time data for the SeaBus, but the vessels broadcast AIS. [aisstream.io](https://aisstream.io/documentation) streams it free over a WebSocket, filtered by MMSI and bounding box. Its key (`AISSTREAM_API_KEY` in `.secrets`) must stay on the server, and there's no SLA and no history, so we record our own.

- **Ingest** (`server/rt/ais.ts`): the RT service's leader keeps one WebSocket open (reconnecting with backoff) for the fleet's MMSIs (`data/config/seabus.json`), keeps two days of fixes in memory, and records them in batches every 10 s with the RT recorder's format (`data/ais-history/YYYY-MM-DD/HH.ndjson.gz`; an empty batch while connected keeps coverage going). `GET /rt/ais/fixes?date=YYYYMMDD[&after=cursor]` serves a service date's fixes; the cursor counts arrivals (bursts arrive out of time order) and `epoch` changes on restart.
- **Matching** (`src/core/ais/match.ts`, pure): each fix matches the trip whose berth-to-berth path it lies on (within 200 m, course within 60° of the path) and whose timetable is nearest (±10 min). A moving fix anchors the trip ("here at t"); a docked fix only moves the timetable if it contradicts it (still docked after departure, or docked before arrival). Lateness carries into the vessel's next trips, less layover slack beyond a 90 s turnaround. Each block takes the name of the vessel with the most fixes on it. Fixes that match nothing (the layup berth, the spare) are ignored, so out-of-service vessels stay hidden.
- **Display**: the browser (`src/app/ais.ts`) polls the fixes for dates in progress, runs the matcher and passes the result to the schedule engine as `ScheduleCorrections`, like sightings. Vessels are drawn on our lanes, shifted to agree with the fixes: observed within 90 s of a fix, interpolated between, carried (estimated) after. Manual observations take precedence.
- **Smoothing** (`src/core/ais/glide.ts`, like buses' glide): when new fixes arrive at time K, each vessel glides from where it was drawn to where the new corrections put it instead of jumping: drawn behind, it catches up at up to 4 m/s extra over 3–30 s; drawn ahead, it holds (≤ 90 s). Under 5 m nothing changes; over 400 m (or across trips, other than leaving the dock) it jumps. The glide is expressed as anchors, used only for display times in its window; elsewhere every fix is used (hindsight), so replays interpolate between fixes and never jump. Live check (2026-09-29 AM peak, 3 min): largest step 8 m per 250 ms frame; a 300 m correction became a 30 s catch-up.
- **Why anchors, not raw positions**: fixes arrive irregularly from volunteer receivers (30-minute probe, 2026-09-28 evening: per vessel in service a median ~60 s apart, p90 2–3 min, max ~4 min). Anchoring the timetable degrades gracefully to "schedule + known delay" instead of freezing or jumping.
- **Tools**: `scripts/probe-ais.ts` records raw messages and summarises the feed; `scripts/eval-ais.ts [date]` reports matches, lateness, vessels per block and the berths used.
- **Berth pair of the day**: the plan carries every pair's paths (`ServicePlan.ferry`) and trips use the default pair's. When a day's docked fixes are mostly (≥ 2, more than all others together) at another pair's berths, the matcher sets `ScheduleCorrections.shapes`, and the engine draws that whole day along the other pair's paths (distance scaled; timing unchanged). Route lines show both pairs: the day's pair solid, the other dotted (map global state `ferryPair`, set from the day shown).
- **Later**: lanes regenerated from recorded tracks.

## 5. Repository layout

```
skytrain-viz/
  CLAUDE.md, README.md, PLAN.md, LICENSE
  docs/OPEN-QUESTIONS.md      # operations questions → config values
  .secrets                    # gitignored; TRANSLINK_API_KEY=...
  data/
    raw/                      # gitignored: GTFS zips, OSM extracts, basemap source
    rt-history/               # gitignored: recorder output
    infrastructure/           # committed: tracks.generated.geojson, overrides.json, diagram-checklist.json
    config/                   # committed: kinematics, dwell, turnbacks, yards, consists, fleet caps
    observations/             # committed: manual corrections
    disruptions/              # planned: closures and service changes (dispatcher inputs, §4.11)
    scenarios/                # committed: scenario bundles
  scripts/                    # tsx: fetch-gtfs, build-schedule, fetch-osm, import-osm, infer-runs,
                              #      build-movements, validate-*, scenario, tiles
  src/
    core/                     # DOM-free; shared by scripts, tests, workers
      gtfs/  infra/  runs/  movement/  dispatch/  corrections/  scenario/  rt/
    app/                      # map, layers, clock, controls, inspect
  server/                     # RT service: poller, cache, recorder, history endpoints, later live dispatch (Node)
  worker/                     # later: Cloudflare Worker + Durable Object port of server/
  public/                     # static assets; public/data and public/tiles are gitignored build output
  test/
```

## 6. Milestones

Each milestone ends with something you can look at.

1. **M0 – Scaffold.** Vite+TS, LICENSE, lint/test setup, feed discovery + manifest, service plan build, and the service-day resolver with tests (weekday vs. Mon–Thu supplements vs. holidays vs. >24:00). PMTiles extract and basemap style.
2. **M1 – First light.** Basemap, GTFS shapes and stations for all 12 routes, the clock and time controls (including mobile layout), and every vehicle naively interpolated along shapes. This validates the clock, rewind, day and feed switching, and performance end to end.
3. **M2 – RT service.** Single poller + cache + CORS, the recorder, history and coverage endpoints, and bus provenance rendering with the coverage strip. It lands early so the recorder starts collecting history sooner.
4. **M3 – Track graph: Expo + Millennium.** OSM fetch and import, overrides, platform mapping, the diagram checklist, the validator, and zoom-dependent track rendering including OMC 1 and the Coquitlam yard.
5. **M4 – Trains on tracks: Expo + Millennium.** Run inference, routing, kinematics, conflict check, trains on the correct tracks with turnbacks, and yard pull-outs and pull-ins. Includes a fleet-count debug chart.
6. **M5 – Canada Line.** Graph (both branches, Capstan, Bridgeport OMC) and runs.
7. **M6 – Corrections.** Observation format, reconciler, observation files, and provenance in the inspect view.
8. **M7 – Scenarios.** Infra diffs, service-pattern generator, and `npm run scenario`, plus one demo scenario (e.g. an extra crossover, or a Millennium stub toward UBC).
9. **M8 – Dispatcher** (§4.11), in steps that each end with something to look at:
   1. *Core:* base plans are built through the dispatcher with no inputs (moving block, route locking, berths). Done when `validate:plan` shows no conflicts outside yards, the added delay is small (p95 target set from the first build), and the Braid meeting is gone.
   2. *Anchors:* rail observations go through the dispatcher; `warp()` is retired for rail.
   3. *Disruptions from files:* `data/disruptions/*.json` closures and service changes. First case: Canada Line single-tracking between Bridgeport and Richmond-Brighouse (Sep 27–30).
   4. *Live central dispatch:* input-triggered re-dispatch in the RT service with checkpoints, versioned patches, a `/rt/live` pointer, and patch loading in the client.
   5. *Alerts:* §4.10 alerts become draft disruption inputs, confirmed by a person.
10. **Later – Public deploy.** Static host, Worker + Durable Object for the poller, recorder and dispatcher, R2 for tiles, history and dispatch versions.

## 7. Validation and testing

- **Unit tests (vitest)** in `src/core`:
  - service-day resolution and time parsing
  - feed selection across overlapping feeds
  - routing with switch pairings
  - `positionAt` continuity and monotonicity
  - bus provenance resolution (observed, interpolated, or estimated at coverage edges)
  - RT cache behaviour: one upstream call per interval under N concurrent clients
- **`npm run validate:infra`**:
  - every rail platform `stop_id` maps to exactly one platform
  - every consecutive stop pair in every trip is routable
  - every terminus has a legal turnback
  - every yard is reachable
  - no dangling nodes
  - the diagram checklist is satisfied
- **`npm run validate:plan`**:
  - no conflicts (enforced once the dispatcher lands; reported until then)
  - added delay vs the timetable and holds by place (with the dispatcher)
  - no teleports between movements
  - fleet in service ≤ per-line caps
  - yard occupancy ≤ capacity
- **Debug view** (`?debug=1`): unmatched trips, conflicts, and per-line fleet-in-service-over-time charts. The charts are a quick sanity check against known peak train counts.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The OSM track graph has gaps or errors. | Overrides file survives re-imports; validator and diagram checklist; start with Expo+Millennium. |
| Run inference is implausible (fleet counts, turnbacks, layups). | Everything lives in config; fleet chart; block_id hint; corrections layer; [open questions](docs/OPEN-QUESTIONS.md). |
| RT API limits or outages. | Single poller with fixed upstream rate; stale-snapshot serving; automatic estimated fallback with a visible badge. |
| The recorder only covers time when it was running (a local laptop). | Honest coverage strip. The public version moves the recorder to an always-on Durable Object. |
| GTFS changes (new signup periods, route IDs, platform stops). | Select by name; per-feed builds; the validator fails loudly on unmapped platforms. |
| The dispatcher adds unrealistic delays or deadlocks. | Route locking (never enter a section you can't leave), delay reports per line, deadlock fixtures in tests, field checks against GPS rides. Rules and parameters live in config. |
| Untrusted input on a public server changes what everyone sees. | Only committed files, confirmed alerts and authenticated submissions feed the dispatcher. Visitor requests never trigger a dispatch. |
| Data size in the browser. | Per-service-pattern movement files, lazy-loaded; PMTiles range requests; simplified yard geometry at low zoom. |
