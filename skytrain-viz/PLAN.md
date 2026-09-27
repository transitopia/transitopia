# SkyTrain Viz: Implementation Plan

Status: **implemented through M7** (2026-09-25). Operations questions still open are tracked in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md). They refine config values and don't block anything.

## Implementation status

| Milestone | State | Notes / deviations from the plan below |
|---|---|---|
| M0 scaffold + timetables | ✅ | Feed discovery, per-feed plans, manifest, service-day resolver (DST-safe). |
| M1 first light | ✅ | Vehicles are drawn by a small WebGL custom layer, not deck.gl: deck.gl's MapLibre integration breaks on maplibre-gl v6. |
| M2 RT service | ✅ | One poller per machine (lock file with follower forwarding), hourly NDJSON recorder, coverage index, live/recorded/estimated provenance. |
| M3 track graph | ✅ | Platforms are mapped by global optimisation (route consistency, distinct tracks, feasible turnbacks), not nearest-track. Two Canada Line Waterfront platforms are pinned by override. OSM "under works" Expo track near Braid is treated as in service (OPEN-QUESTIONS #17). |
| M4 trains on tracks | ✅ | SkyTrain trips are re-timed within GTFS minute rounding. Trips are chained FIFO (GTFS blocks only where they're physically continuous). Stub-berth allocation. Known limitation: terminus overlaps at peak and pull-out interference, reported by `validate:plan` (OPEN-QUESTIONS #21–22). |
| M5 Canada Line | ✅ | Came with M3/M4: the graph covers all lines, including Capstan and the Bridgeport OMC. |
| M6 corrections | ✅ | Observations reference service date + trip, or stop + time. Delays are absorbed at layovers. Cancellations, consists and provenance are shown. |
| M7 scenarios | ✅ | Future OSM track, custom GeoJSON track, `extend` service operation. Demo: `broadway-subway`. |
| Public deploy | ⏳ | Not started (Cloudflare Worker + Durable Object poller, R2 for tiles/history). |
| **TODO: service alerts → schedule overrides** | ⏳ | Needed: planned SkyTrain changes (e.g. nightly single-tracking) exist only in the GTFS-RT alerts feed, not in static GTFS or trip updates. See §4.10. |

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

The core design principle is that **every vehicle position is a pure function of (movement plan, overlays, time)**. Nothing steps a simulation forward frame by frame. That makes seeking, rewinding, and 1000× fast-forward trivial and deterministic, and it makes corrections and scenarios composable, because they just produce a different plan or overlay.

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

Script: `scripts/build-movements.ts`. The same code runs in a Worker for scenarios.

- **Routing**: each leg (platform → platform, yard → platform, turnback) is routed on the track graph by shortest path, respecting switch pairings. Legs start and end on the specified platform's track.
- **Timed paths**: each leg becomes a list of `(edgeId, fromOffset, toOffset)` plus a time profile. Per-line kinematics (accel, decel, top speed, dwell; all in config) are fitted so run time matches the schedule. Slack goes into the dwell.
- **Conflict check** (validation only): flags two runs occupying the same track span at once. This catches modeling errors early and infeasible scenarios later.
- **Runtime**: `positionAt(run, t)` binary-searches the timed path, applies the kinematic interpolation, and maps the edge offset to lat/lon plus bearing.

### 4.5 SeaBus, West Coast Express, and buses

- **SeaBus and WCE** are schedule-based, interpolated along GTFS shapes with ease-in/out between stops. Vessels and trainsets are chained by block_id. No infrastructure model. WCE mid-day and overnight storage is an open question: whether to show parked trainsets at all.
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
  - **Shifted GPS**: some buses report positions offset hundreds of metres from where they are (seen 2026-09-26: an R4 and a 99 ~350–620 m north of their routes for 30+ min, on time; TransLink's stop matching stalls on such buses, so its next stop stays at stop 1 and its delay grows by 30 s every 30 s). Fixes 150 m–1 km off the trip's shape are placed on the route at their along-route position when they progress plausibly from the last placed fix (≤ 15 m/s, steady offset) or fit the timetable (± 20 min); they're *interpolated* and noted in the inspect panel. When TransLink's next stop is > 200 m behind the bus, next stop and delay come from the position instead. Fixes that can't be placed (e.g. buses going to/from the depot, > 1 km off) are shown as reported with a note and no delay. Recorded data: 98.7 % of fixes within 50 m of their shape, 0.2 % 300 m–1 km (mostly those two buses), 0.2 % > 1 km (mostly null-island fixes).
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
- The file layout maps directly onto R2 objects for the public version.

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

A **reconciler** adjusts a run's timeline from observations:

- Anchoring times shift subsequent stops, decaying back toward the schedule at later termini.
- Timetable-based vehicles (SeaBus, WCE, buses without real-time data) use a simpler reconciler, `reconcileScheduled`. A sighting shifts its trip (linearly between several sightings), and the terminal layover stretches to the next trip's corrected departure. A consist or vessel name applies to the whole GTFS block.
- Cancellations drop trips and re-chain the affected runs.
- Consist data attaches to runs.
- Affected spans get `provenance: observed | interpolated`.

Sources:

- `data/observations/*.json` files
- later, a rail RT adapter if TransLink publishes one

The bus RT history is effectively the first observation source. It uses the same reconciler concepts in a simpler form.

### 4.8 Scenarios (config files)

A scenario is a directory in `data/scenarios/<name>/`:

- `infrastructure.json`: a diff against the base graph (add, remove, or modify segments, switches, platforms, and yards; new segments as GeoJSON)
- `service.json`: either `{ "base": "gtfs" }` or a service-pattern spec that generates trips, e.g. line, pattern (origin → destination, stopping platforms), headways by time band, and short-turn rules
- optional `config.json`: overrides for kinematics, fleet caps, and turnback times

`npm run scenario <name>` runs the full pipeline (apply diff → validate → generate trips → infer runs → route → conflict check) and writes `public/data/scenarios/<name>/`. The app picks scenarios via `?scenario=<name>`. There's no editing UI. An in-browser Web Worker recompute can come later if it's wanted.

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

### 4.10 TODO: service alerts as dated schedule overrides

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
3. **Apply per date.** A service date with active overrides gets its own movement build: base plan + overrides → platform mapping → run inference. The same pipeline as scenarios, keyed by date instead of name, built on demand or ahead for announced dates.
4. **Show it.** A banner or badge when the displayed time has an active alert, the alert text in the inspect card, and provenance "adjusted by TransLink alert" on affected trains.
5. **Hand overrides.** The same override format should also accept manual entries (`data/observations/` or a sibling), for disruptions without a parseable alert.

**Open points:**
- Which track is closed when an alert says only "single-track": needs ground truth, as at Braid.
- How to time the reduced-headway pattern relative to the rest of the line.
- How to treat alerts whose text changes between polls.

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
    scenarios/                # committed: scenario bundles
  scripts/                    # tsx: fetch-gtfs, build-schedule, fetch-osm, import-osm, infer-runs,
                              #      build-movements, validate-*, scenario, tiles
  src/
    core/                     # DOM-free; shared by scripts, tests, workers
      gtfs/  infra/  runs/  movement/  corrections/  scenario/  rt/
    app/                      # map, layers, clock, controls, inspect
  server/                     # RT service: poller, cache, recorder, history endpoints (Node)
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
9. **Later – Public deploy.** Static host, Worker + Durable Object poller/recorder, R2 for tiles and history.

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
  - no conflicts
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
| Data size in the browser. | Per-service-pattern movement files, lazy-loaded; PMTiles range requests; simplified yard geometry at low zoom. |
