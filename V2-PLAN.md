# Transitopia V2: Plan (draft)

Status: **draft**, revised 2026-09-29 with two rounds of decisions (§0). The questions still open are in §12. Items marked *(proposed)* are assumptions until they're confirmed.

Transitopia V2 merges two projects:

- **Transitopia** (this repo): the public site at transitopia.org. It has a cycling/micromobility map for British Columbia and a placeholder walking map.
- **skytrain-viz** (`~/skytrain-viz`, to be merged in with its full history): a real-time and schedule-driven animation of Metro Vancouver transit. It shows SkyTrain on the right track through every switch, SeaBus from live AIS, West Coast Express, and the 99 and R1–R6 buses from GTFS-RT. It has a time slider covering past, live and projected future, corrections, disruptions, scenarios, and a signalling-aware dispatcher.

V2 is one site with transit and cycling modes (walking returns later), backed by a long-running server in Canada and a PostgreSQL database for everything we collect and curate.

---

## 0. Decisions so far (2026-09-29)

| Topic | Decision |
|---|---|
| Basemap | **Protomaps** for the whole site. Transitopia's OpenMapTiles basemap is retired, and the cycling overlay stays a separate source. |
| Hosting | **FullHost** (Canadian provider with data centres in Vancouver, Calgary, Toronto and Montreal) for the VM, and possibly its S3-compatible object storage, to keep data in Canada. Details in §7. |
| Frequency metric | The **90th-percentile gap over the upcoming hour** from the time being viewed, per service and per shared corridor, computed at least every 30 min. How to summarise across the day or week is decided later (§5.5). |
| Priorities | 1. Parity with today's Transitopia (cycling) and skytrain-viz (all of it). Walking mode is dropped for now. 2. Details panels. 3. Frequency map. 4. Submissions and annotations. 5. Micromobility. 6. All buses. 7. Mobile app. 8. Trip planning. Improving **data quality and performance** runs continuously alongside all of these (§9.1). |
| Accounts and submissions | **GitHub login**, with a **dedicated public GitHub repo** for data issues and submissions. Anonymous reports are allowed, but an admin reviews them before they're posted anywhere. We contribute fixes upstream to OSM where we can. |
| Mobile app | Low priority. Mobile web must be good enough for testing and reporting. **Capacitor** is tentatively accepted and will be reviewed in detail before starting. |
| Trip planning | Wanted, but after the mobile app. Evaluate reusing an existing system (the Transit app's API, OpenTripPlanner, MOTIS, …) before building anything. |
| Code license | **MIT** across the whole repo. |
| Data license | **ODbL** wherever we can, including our own original content. No dual licensing (§10.2). |
| Statistics | "On time" means **1 minute early to 3 minutes late** at timepoints. **Observed stop times are kept indefinitely** (§4.4). |
| skytrain-viz polling | The request budget (§4.5) is implemented in skytrain-viz **now**, and carries over in the merge. |
| Phase 0 timing | The repo merge **waits until this plan settles**. |
| Data snapshots | The server records all the time. Developers can pull snapshots of production data into their environment. Whether each dataset can be published depends on its source's license, checked source by source (§10.3). Data we may not publish stays private to the team. |
| TransLink API | Unless TransLink approves a more useful request limit, stay within **1,000 requests a day** across all TransLink endpoints, polling more often at peak and less off-peak (§4.5). |
| Attribution | Shown **dynamically**: the map credits exactly the datasets visible at the time (§4.6). |
| Data residency | Nothing here is sensitive. Cloudflare's CDN is fine where it helps performance or security, and files on R2 stay there for now. The database and server are on FullHost. |
| Retention | Raw real-time data (GTFS-RT, AIS, GBFS) is kept **60 days**. While it's in that window, we compute per-route statistics (on-time, delays, cancellations, …) and keep those **indefinitely** for year-over-year analysis. GTFS static feeds are kept **indefinitely** (§4.4). |
| Basemap extent | **BC** for now, then Canada, then Canada + US, then the planet. |
| Environments | Production and local dev for now, with a staging environment planned for later (§7.4). |
| Analytics | Privacy-friendly analytics (§7.6). |
| Annotations | Live in the database, with an **optional** linked GitHub issue. |
| GitHub data repo scope | **Pending** until we know which data files we can share and how that maps onto the reports users submit (§12). |
| Fleet data | **Our own data**: sightings, photos, reports and recorded tracks. **CPTDB Wiki is used only to check ours**, never copied, so its share-alike and attribution terms don't apply to our data (§5.3). |
| Photos | Our own uploads plus **hand-picked** Wikimedia Commons (or similar) photos with license metadata. Never automatic. |
| Repo merge | Import skytrain-viz's entire git history into this repo. |
| Rail detail elsewhere | The long-term goal is SkyTrain-level detail in other cities (Montreal, Toronto, San Francisco, …). Grow one city at a time, with a focus on data quality and local advocacy: Vancouver first, **Montreal** next (a long way off), then other cities. |
| Corrections storage | Observations and disruptions move from git into the database, with a file export. Each can be **toggled on and off and previewed** before it's confirmed (§5.6). |

---

## 1. Where each project stands

### 1.1 Transitopia (today)

| Part | What it is |
|---|---|
| `web-ui/` | Vite 8 + React 19 + Tailwind 4 SPA. Routing with `wouter` (`/cycling`, `/walking`; `/transit` is commented out). `@tanstack/react-query` and `zod` load OSM feature details from the OSM API for infoboxes (e.g. bike parking). MapLibre GL v6, loaded asynchronously, with the worker URL set explicitly. Map position is in `?z=&lat=&lng=`. Lint is oxlint and formatting is prettier. |
| Basemap | `transitopia-base-bc.pmtiles` is built by `transitopia/planetiler-openmaptiles` (OpenMapTiles schema, customized Positron style, all of BC). Glyphs come from `fonts.openmaptiles.org`. **To be replaced by Protomaps.** |
| `map-layers/` | A Java 21 Planetiler profile (`TransitopiaCyclingProfile`) that builds `transitopia-cycling-british-columbia.pmtiles` from the Geofabrik BC extract. It stays. |
| CI/CD | `build_cycling.yml` rebuilds the cycling layer daily and uploads it to the R2 bucket `transitopia-maps` with rclone. |
| Hosting | A static frontend on Cloudflare. Production reads tiles from `https://map-tiles.transitopia.org/<name>.json` (a Protomaps-style tile server over R2). There is no server-side state and no database. |

I only reviewed the files named above; other workflows and the tile worker's config weren't reviewed.

### 1.2 skytrain-viz (today)

See its `PLAN.md` for detail. The parts that matter for the merge:

| Part | What it is |
|---|---|
| `src/core/` | DOM-free TypeScript used by build scripts, tests and the server. It covers GTFS ingest and service days, the OSM track graph and platform mapping, run inference, the movement plan, pure playback (`positions = f(plan, overlays, t)`), the dispatcher (moving block, route locking), corrections, disruptions and alert parsing, bus RT prediction (profiles, glide, delay carry-forward, cancellations and detours), AIS matching for SeaBus, and scenarios. This is the valuable part. |
| `src/app/` | Plain TS UI: a clock, time controls, an inspect popover, a legend, and a custom **WebGL2 layer** (`layers/gl-polygons.ts`) drawing to-scale vehicles through MapLibre's public custom-layer API. It already uses a Protomaps basemap (light and dark) with self-hosted glyphs and sprites. |
| `server/` | A Node RT service. One leader per machine (lock file) polls GTFS-RT positions, trip updates and alerts, keeps an aisstream.io WebSocket open, records hourly NDJSON.gz files, stores service changes, drafts disruptions from alerts, and re-dispatches live, serving versioned immutable patches. |
| Data | Committed: `data/config/`, `data/infrastructure/`, `data/observations/`, `data/disruptions/`, `data/scenarios/`. Runtime output: `data/rt-history/`, `data/ais-history/`, `data/dispatch-history/`, `public/data/`. |

### 1.3 Where the two conflict

| Topic | Resolution |
|---|---|
| UI framework (React vs plain TS) | React for chrome (panels, forms, routing). The transit engine and its WebGL layer stay framework-free and are mounted imperatively on the shared map (§4.2). |
| Basemap schema | **Protomaps** (decided). Transitopia's cycling styling is re-tuned against the Protomaps basemap. |
| Glyphs and sprites | Self-hosted, from skytrain-viz's setup. |
| URL state | One scheme: path = mode (`/transit`, `/cycling`), `#map=z/lat/lng` shared across modes, and the query string holds mode state (`date`, `t`, `rate`, `layer`, `scenario`, `select`). Old `?z&lat&lng` links redirect. |
| Lint and format | Transitopia's oxlint + prettier repo-wide, applied to the imported code in one mechanical commit. |
| Server | skytrain-viz's RT service becomes `apps/server`, with PostgreSQL (§4.3–4.4). |
| Deployment | FullHost VM + PostgreSQL for dynamic data. Cloudflare stays for DNS, CDN, edge security and R2 (§7.2). The Worker/Durable Object plan is dropped. |

---

## 2. Goals

**Parity (first priority)**
- The cycling map as today, on the new basemap and shell.
- Everything skytrain-viz does: real-time animation with a time slider over past, live and projected future; data blending with provenance; disruptions; live dispatch; SeaBus AIS; buses with prediction.

**Then, in order**
1. Details panels: vehicles and vessels (which vehicle, status, fleet data) and stops and stations (photo, weather protection, elevator status, frequency graphs per service and combined).
2. The frequency map (great < 3 min, good < 6, not so great < 12, bad < 16, poor ≥ 16).
3. Submissions (corrections, missing data) and advocacy annotations.
4. Micromobility availability (Mobi, scooters and e-bikes via GBFS).
5. Live status of all buses in the region.
6. Mobile app (Capacitor), including "record vehicle track".
7. Trip planning (reusing an existing system if possible).
8. More regions, one city at a time: Canadian cities next, then others. The eventual goal is track-level rail detail in each.

**Continuous:** data quality and site performance (§9.1).

**Deferred:** walking mode (dropped from the UI until it has real content) and editing scenarios in a UI.

---

## 3. Guiding principles

These are skytrain-viz's ground rules, extended site-wide:

1. **Positions are a pure function of (plan, overlays, t).** No frame-stepped state in the client. This is what makes the time slider work, and it applies to every mode we animate.
2. **Provenance everywhere.** Vehicles carry `observed | interpolated | estimated`. Curated facts carry a source and a date. Never present an estimate as fact.
3. **Upstream APIs are polled centrally,** within each provider's limits and on an explicit request budget (§4.5). Client requests never trigger calls to TransLink, aisstream, GBFS or OSM, and neither do development machines (§7.5).
4. **Shared state is computed centrally.** The dispatcher, frequency analysis and disruption parsing run on the server or at build time. Every visitor sees the same versioned result.
5. **Secrets never reach the browser or the app bundle.**
6. **Infrastructure is data.** OSM first, fixed upstream where possible. Our own fixes are reviewable data.
7. **Nothing untrusted reaches the public map or the dispatcher without review.** Drafts can be previewed (§5.6), but only confirmed inputs are published.
8. **Static first, dynamic where needed.** Anything that can be an immutable file behind a CDN should be one. The server handles live data, writes and moderation. If the server is down, the site degrades to schedule estimates instead of breaking.
9. **Licensing is tracked per dataset** (§10). Every dataset records its source and license, and publishing respects them.

---

## 4. Target architecture

```
                         ┌────────────── CDN / edge (Cloudflare today; see §7) ──────────────┐
 Browser / app ────────▶ │ www.transitopia.org        static SPA                              │
                         │ map-tiles.transitopia.org  basemap, cycling, frequency tiles       │
                         │ data.transitopia.org       immutable build output (plans, movements,│
                         │                            dispatch patches, public archives)      │
                         │ api.transitopia.org ─┐     proxied; /rt/live edge-cached 10 s       │
                         └──────────────────────┼────────────────────────────────────────────┘
                                                ▼
                         ┌───────────── FullHost VM, Vancouver (Docker Compose) ────────────┐
                         │ server (Node/TS)                                                 │
                         │  ├ API: live, history, changes, dispatch (+ previews), stops,    │
                         │  │      vehicles, annotations, reports, auth, admin              │
                         │  ├ leader (pg advisory lock): GTFS-RT, AIS, GBFS, alerts,        │
                         │  │      recorder, live dispatcher, feed watcher + builds         │
                         │  ├ jobs: aggregates, frequency, archiving, tiles, GitHub sync    │
                         │ PostgreSQL + PostGIS · Caddy (TLS) · backups                     │
                         └──────────────────────────┬───────────────────────────────────────┘
                                                    ▼
                         Object storage: FullHost S3 (Canada) for archives, backups, private
                         data; public immutable files there or on R2 (§7.2)
                         GitHub: transitopia/<data-issues repo> ◀── issues synced both ways
```

### 4.1 Repository layout

skytrain-viz comes in with its full history: `git filter-repo --to-subdirectory-filter` on a clone, then `git merge --allow-unrelated-histories`, then moves into the layout below in follow-up commits so that `git log --follow` works.

```
transitopia/
  README.md, V2-PLAN.md, CLAUDE.md, LICENSE (MIT), DATA-LICENSES.md
  package.json                      # npm workspaces
  apps/
    web/                            # React SPA (today's web-ui/ + skytrain-viz's app shell)
    server/                         # Node API, pollers, recorder, dispatcher, jobs
    mobile/                         # later: Capacitor shell around apps/web
  packages/
    transit-core/                   # skytrain-viz src/core: DOM-free, tested
    transit-map/                    # skytrain-viz src/app engine: clock, playback, WebGL layers; no React
    map-style/                      # Protomaps style, fonts, sprites, colour tokens (light/dark)
    db/                             # SQL migrations, typed queries (Kysely), import/export, snapshots
    shared/                         # zod schemas for API payloads (web, server, app)
  pipelines/                        # fetch-gtfs, import-osm, build-movements, frequency, validators, …
  map-layers/                       # Planetiler Java profile(s): cycling, later more
  regions/
    metro-vancouver/                # region.json, config/, infrastructure/, scenarios/, fixtures/
  infra/                            # docker-compose.yml, Caddyfile, provisioning, backup config
  docs/                             # OPEN-QUESTIONS.md, data-sources.md, ADRs
```

### 4.2 Frontend

- **One map, several mode layers.** `apps/web` keeps Transitopia's `<Map>` and context. `CyclingMap` stays as is. `TransitMap` creates the engine on mount (`createTransitEngine(map, { region, dataBase, apiBase })`) and disposes it on unmount. `WalkingMap` and its nav button are removed for now.
- **React ↔ engine bridge.** The engine keeps its tiny store (clock, selection, feed and date, badges). React reads it with `useSyncExternalStore`. The per-frame path (clock → playback → WebGL) never goes through React.
- **Details panels** are one component family: a side panel on desktop and a bottom sheet on phones. It covers vehicle, stop/station, cycling way, parking, annotation and dock/scooter.
- **Dark mode** site-wide via `map-style` tokens (skytrain-viz already has a dark basemap).
- **Chunking**: MapLibre stays lazy, and the transit engine is its own chunk loaded on `/transit`.
- **Accessibility**: keyboard-navigable controls, and colour-blind-safe scales. For the frequency map, pair colour with width or dash.

### 4.3 Server (`apps/server`)

- **Node 22+, TypeScript**, reusing `transit-core` directly. *(Proposed)* **Hono** for HTTP, and `zod` from `packages/shared` to validate requests.
- **Leader election** via a Postgres advisory lock (it replaces the lock file). Exactly one process polls, records and dispatches.
- **Jobs** in Postgres (`graphile-worker` or `pg-boss`): aggregates, archiving, frequency builds, GTFS builds, GitHub issue sync, snapshot exports.
- **Live data**: `/rt/live` stays a small snapshot polled every 10–30 s and cached at the edge for 10 s, so server load doesn't grow with visitors.
- **Immutable outputs** (movements, dispatch patches, archives, frequency data) go to object storage under content-hashed paths. The API returns pointers to them.
- **Admin UI**: `/admin` in the SPA, gated to admins signed in with GitHub. It holds the review queue for reports, disruption drafts (replacing `npm run disruptions`), observation previews (§5.6), and the fleet and photo curation tools.

### 4.4 PostgreSQL

**PostgreSQL + PostGIS** on the FullHost VM.

| Data | Store |
|---|---|
| Raw poll snapshots (GTFS-RT, AIS, GBFS) | **Kept 60 days**: in Postgres (partitioned by day, so expiry is dropping a partition), plus hourly NDJSON.gz files (today's format) in object storage for dev snapshots and replay. Both expire together. |
| Observed stop times per trip (the "atom" behind the statistics) | Kept **indefinitely** (decided), as monthly compressed files in object storage, with recent months also in Postgres. See the retention section below. |
| Per-route statistics (on-time, delay, cancellations, delivered headways, …) | Postgres, kept **indefinitely** |
| Service changes, alerts (first and last seen), elevator status history | Postgres |
| Observations, disruptions, dispatch versions (metadata; blobs in object storage) | Postgres, with states `draft → previewing → confirmed | discarded` and an export to files for tests and reproducible bug reports. |
| Stations, station facts, photos (metadata; images in object storage), fleet | Postgres |
| Annotations, reports, users | Postgres + PostGIS, linked to GitHub issues (§5.9) |
| Scenarios, infrastructure overrides, operations config | **Git** (build-time inputs checked by the validators) |
| GTFS static feeds | **Kept indefinitely**: the original zips in object storage, plus a `feeds` table and the built plans. A few feeds a year at tens of MB each costs next to nothing. |

**Volume check (all buses).** Assume ~1,000–1,500 buses at peak (to verify). At the budgeted polling rate (§4.5: fixes every 1–3 min), that's roughly 0.5–1 M position rows a day, or about 30–60 M rows in the 60-day window. That's small for one VM. If TransLink raises the limit, polling every 30 s would be about 2–4 M rows a day, which is still comfortable.

**Retention and derived statistics.** Raw data is deleted after 60 days. Any statistic we haven't computed by then can never be computed for that period. So:

- **Observed stop times are the atom.** From each vehicle's fixes we derive, per trip and stop, the observed (interpolated) arrival and departure, its precision (the time between the fixes it came from), and the matching scheduled time. At roughly 0.5–1 M rows a day, that's a few GB a year compressed. Nearly every statistic can be recomputed from it, including ones we haven't thought of yet. It's kept indefinitely (decided) as monthly files in object storage.
- **A nightly job** (and a catch-up job on startup) computes statistics for each finished service date, **while the raw data is still there**:
  - Per route, direction, day and time band: trips scheduled, trips observed, trips cancelled (from service changes), skipped stops.
  - On-time performance at timepoints (on time = **1 min early to 3 min late**, decided; stored in config), delay percentiles, early departures.
  - Delivered versus scheduled headway, including the p90 gap (the same metric as the frequency map) and a bunching index.
  - Run-time percentiles per segment (congestion trends), fleet in service, and RT coverage.
- **Coverage is the denominator.** Every statistic records how much of the period our recorder actually covered. "Cancelled" and "on time" are only meaningful where we were recording. Gaps are reported as gaps, never as zeros.
- **Statistics are versioned.** Each row records the version of the statistics code that produced it. If the definition changes, the atom lets us recompute history.
- **The same applies to SeaBus (AIS)**: observed departures and arrivals per sailing, and the vessel per block, kept indefinitely.

**Access layer**: plain SQL migrations + **Kysely**.

Core tables (illustrative):

```
regions, agencies, feeds, routes, stops
stations(id, region_id, name, geom, osm_ids)                 -- durable across GTFS feeds
station_facts(station_id, key, value, source, observed_at, license, status)
elevators + elevator_status(elevator_id, status, period, source)
photos(id, subject, object_key, license, author, source_url, status)
fleet_vehicles(agency_id, vehicle_ref, model, year, propulsion, source, license, verified_at)
rt_positions (partitioned by day, 60-day retention), observed_stop_times, service_changes, alerts, ais_fixes
route_stats_daily(region, route_key, direction, service_date, band, metrics jsonb, coverage, stats_version)
upstream_requests(provider, endpoint, ts, status, bytes)          -- budget accounting (§4.5)
gbfs_systems, gbfs_status (hot)
observations, disruptions (spec, state, preview_version, …), dispatch_versions (incl. previews)
annotations(id, region_id, mode, category, severity, geom, status, github_issue, …)
reports(id, kind, payload, geom, reporter_github_id | null, ip_hash, state, github_issue, reviewed_by)
users(id, github_id, login, role), sessions
datasets(id, source, license, publishable, attribution)      -- drives snapshot/export rules (§10)
```

### 4.5 Upstream request budget

Until/unless we get a higher polling budget approved (§10.3), the leader stays within **1,000 TransLink requests a day**, counted across `gtfsposition`, `gtfsrealtime` (trip updates) and `gtfsalerts`. The polling rate varies with the time of day and lives in config (`regions/metro-vancouver/config/rt.json`), not code.

Proposed weekday schedule (Pacific time; guesses to tune with `eval-rt`):

| Band | Hours | Positions | Trip updates | Alerts | Requests |
|---|---|---|---|---|---|
| Peak: 06:30–09:30, 15:00–18:30 | 6.5 h | every 60 s (390) | every 4 min (~98) | every 20 min (~20) | ~507 |
| Day and evening: 05:00–06:30, 09:30–15:00, 18:30–23:00 | 11.5 h | every 150 s (276) | every 10 min (69) | every 30 min (23) | 368 |
| Night: 23:00–05:00 | 6 h | every 5 min (72) | every 30 min (12) | hourly (6) | 90 |
| **Total** | 24 h | 738 | ~179 | ~49 | **~965**, leaving ~35 in reserve |

Saturday and Sunday/holiday schedules have their own tables (flatter, with a midday peak).

- **Hard cap**: a persistent counter (`upstream_requests`) counts every attempt, including failures and retries. The poller stops at the cap minus the reserve. Error backoff therefore spends budget, so backoff is long, and a restart doesn't reset the count. Only the leader polls (advisory lock), so there's one counter.
- **Recording all routes costs no extra requests.** Each response already covers every TransLink vehicle, so the recorder keeps everything, not just the 7 displayed routes. It only costs storage.
- **Effect on quality**: fixes come 1–5 min apart instead of ~30 s. Bus prediction, glide and delay carry-forward already handle gaps, but accuracy will drop. Before tuning the table, measure it by replaying recorded history thinned to these intervals (`eval-rt --subsample <s>`, a small addition). Cadence-dependent thresholds (coverage gaps, "observed" windows, and the precision of observed stop times) must follow the interval actually in use rather than a constant.
- **Later**: adaptive polling, e.g. a burst of alert polls after a new SkyTrain disruption alert appears, paid for out of the reserve. Other providers (aisstream, GBFS) get budgets under their own terms.

### 4.6 Attribution

Each dataset has a registry entry in `packages/shared`: id, short credit, full legend text, link and license. Every map source, layer and engine component declares which datasets it draws from. For example:

- basemap → OSM + Protomaps
- scheduled transit → TransLink GTFS
- live buses → TransLink GTFS-RT
- SeaBus corrected by AIS → the AIS provider
- docks → the operator's GBFS
- annotations → Transitopia contributors

A React attribution control (replacing MapLibre's default) shows the credits for **what is visible now**: the layers turned on, plus whether the engine is currently drawing any vehicle from that dataset. On phones it collapses to a short line with an ⓘ button that opens the full credits. TransLink's required legend ("Some of the data used in this product or service is provided by permission of TransLink. …") appears in full whenever TransLink data is visible, in the expanded control and in the details panel of TransLink vehicles and stops.

An **About the data** page lists every dataset with its license, and exports carry the same credits.

---

## 5. Features

### 5.1 Modes

`/transit` and `/cycling`, with the map position shared between them. Walking returns when it has content. "Combining modes" later means a secondary mode overlay (e.g. cycling plus stations and bike parking at stations). The layer and panel design should allow two active modes.

### 5.2 Real-time animation and time slider

Port it as is. The engine takes `region`, `dataBase` and `apiBase` instead of assuming same-origin `/data` and `/rt`. Controls become React components. Data URLs are content-addressed, and only the manifest is short-cached.

### 5.3 Vehicle details

- **All**: route, headsign, current or next stop, delay, provenance ("live GPS 12 s ago", "estimated from timetable", "adjusted by alert"), and the reasons for holds.
- **Buses**: vehicle number → fleet record (model, year, propulsion, low floor). Also cancellations, detours and "Between trips".
- **SkyTrain**: run id, consist if known, and a note that the position is schedule-inferred.
- **SeaBus**: vessel name (AIS), speed and the last fix time.
- **Later**: recent path, on-time performance today, and "report something about this vehicle", which pre-fills a report.

**Fleet data is our own.**
- **Sources**: reports ("bus 12345 is a New Flyer XE40"), photos showing the fleet number, recorded tracks tagged with a vehicle number, and admin entry. Each fact carries its evidence (a photo, a report, a sighting) and a confidence.
- **Checking**: an admin tool compares our record against a CPTDB lookup done by a person, not a scrape, and flags disagreements to investigate. Nothing is copied from CPTDB, so our fleet data stays under our own licenses (§10.2).
- **Seeding**: patterns help bootstrap. Fleet numbers often come in blocks by order, so one confirmed bus can suggest the model for its neighbours. Such suggestions are shown as *estimated* until someone confirms them.
- **Ask TransLink**: when contacting them, ask whether they can share a fleet roster (and SkyTrain consist data). Official data would beat everything above.

### 5.4 Stop and station details

A **station** is durable across GTFS feeds and links to OSM objects.

| Item | Source |
|---|---|
| Name, platforms, routes | GTFS |
| Shelter, bench, lighting, tactile paving, wheelchair access | OSM tags, with our `station_facts` filling gaps (with source and date). Where OSM is wrong, fix OSM. |
| Weather protection | OSM plus curated notes (e.g. how much of a platform is covered) |
| Elevators and escalators | Geometry from OSM. Status from TransLink alerts, kept as history so outage frequency can be analysed. |
| Photos | Our uploads plus hand-picked Wikimedia Commons photos, each with license and author |
| Frequency graph | Per route and direction, plus combined for routes sharing the stop in the same direction. It uses the same p90-gap metric as §5.5, drawn as a line over the day. Past dates with RT coverage show delivered next to scheduled. |

### 5.5 Frequency map

**Unit**: a directed **corridor segment** between consecutive stops or stations, served by one or more routes. Routes combine only on segments they share in the same direction. For example, the 99 and R4 combine where they overlap.

**Score (decided): point in time.** For the time *t* being viewed:
- Take the departures along the segment (per route and combined) and the gaps between consecutive departures that overlap the window [*t*, *t* + 60 min]. That includes the gap straddling *t* and the gap running past the end of the window, so a single departure in the hour can't score well.
- The score is the **90th-percentile gap**. With few departures this is effectively the longest gap, which is the intent.
- Thresholds: great < 3 min, good < 6, not so great < 12, bad < 16, poor ≥ 16.

**Computation**: precompute per segment every **30 min** (or 15 min if cheap) per service date:
- **scheduled** from the dispatched plan, per feed, for all dates;
- **delivered** from `observed_stop_times` for past times with RT coverage (buses only, since rail has no RT);
- **projected** (future times on today's date) from the live dispatch and bus predictions.

The client picks the slot for *t*. Segment geometry is a tile layer, and scores are a compact array per date keyed by segment id, applied through feature state. This fits the time slider and stays a pure function of (data, *t*).

**Later presentation** (not decided): daily or weekly summaries, graphs, worst-slot views. Speed stays a separate dimension (width or toggle) until we know what a combined score should say.

### 5.6 Blending data sources, and previewing corrections

It already works in skytrain-viz. V2 changes where the inputs live and adds **previews**:

- Every observation and disruption has a state: `draft → previewing → confirmed | discarded`.
- **Preview**: an admin toggles one or more drafts on. The server dispatches a **preview version** of the affected dates that includes them, stored like any other version but not advertised in `/rt/live`. `?preview=<id>` in the app (admin only, and never cached at the edge) shows it, with a before/after toggle and the `validate:plan` delta (added delay, holds, conflicts).
- **Confirm** publishes the input, and the next regular dispatch includes it. **Toggle off** a confirmed input (e.g. one found to be wrong) re-dispatches without it, and the change is kept in history.
- The precedence order stays documented and visible as provenance: manual observation > live sensor (GTFS-RT, AIS, recorded track) > confirmed disruption or alert > schedule.

### 5.7 Micromobility (GBFS)

- Poll each operator's GBFS centrally at its `ttl`, normalise, cache and serve `/gbfs/live?region=…`. Record to the archive and a hot table. Aggregates such as availability by hour per dock or zone support advocacy.
- Docks are shown sized by bikes and docks available, and free-floating vehicles are clustered at low zoom. History goes on the time slider once there's data.
- Check each feed's license (`system_information.json` `license_id` or `license_url`) before republishing or archiving it publicly (§10.3).

### 5.8 Record vehicle track (with the app)

- The user starts a recording on a vehicle (optionally the route or vehicle number). The app records GNSS fixes and stop events, then uploads. The server turns it into Observations matched to GTFS trips, which become a correction after review (or automatically for trusted users).
- A web version is possible with the screen on. The app (background location) is the real one.
- **Privacy**: trim ~200 m at each end by default, never publish raw tracks tied to a person, allow deletion, and don't expose home stations.

### 5.9 Reports, submissions and GitHub

We use a dedicated public repo as the public tracker for data issues and submissions. Its name, and whether it also mirrors exported datasets, are **pending** (§12) until we know which data files we can share and how that maps onto what users report.

- **Signed in with GitHub**: the in-app form creates an issue through our **GitHub App**. The issue carries a structured payload (kind, location, target ids, a map link) in a fenced block the server can parse, and a "reported by @login" line. The user can then follow and discuss it on GitHub. Users can also open issues directly on GitHub with issue forms that use the same fields.
- **Anonymous**: the report goes into our `reports` table only (rate-limited, with a captcha and a hashed IP). An admin reviews it in `/admin`, and only an approved report becomes a GitHub issue, posted by the bot and credited as "anonymous".
- **Sync**: GitHub webhooks update the report's state in our DB (labels such as `accepted`, `fixed-in-osm`, `wontfix`; closed issues). Accepting a report creates or updates the target record (a station fact, observation, fleet correction, annotation or photo), linked back to the issue.
- **OSM upstream**: reports that are really OSM errors get the label `osm`. An admin (or the reporter) fixes them in OSM, and the next OSM import picks the fix up. For people who don't edit OSM, we can open an OSM note for them.
- **Photos**: uploads go to our object storage, and the uploader picks a license (§10.2). The issue shows a thumbnail link, and we don't use GitHub attachments as the photo store.

### 5.10 Advocacy annotations

- Points or lines (PostGIS) with a mode, a category from a curated taxonomy (*gap in network*, *unsafe crossing*, *missing curb ramp*, *no weather protection*, *bunching hotspot*, …), severity, description, photos, status (*reported, confirmed, fixed*) and links (city plans, 311 tickets).
- The **database holds the annotation** (decided). A GitHub issue for discussion is **optional**: created when an annotation came from a report, or when an admin wants public discussion.
- Served by bbox as GeoJSON at first, or as vector tiles from PostGIS (Martin or `ST_AsMVT`) once there are thousands.
- Computed annotations (e.g. bunching hotspots from delivered headways) are labelled as computed.

### 5.11 All buses in a region

- **Plan chunking** per route or route group, loaded for routes in the viewport.
- **Live data by area**: regional snapshots split into a coarse grid (z10–z11), each edge-cached. Zoomed far out, the client fetches one "positions only" snapshot.
- **Profiles** split per route and loaded lazily.
- **Prediction** runs only for vehicles in or near the viewport, which is cheap because positions are a pure function of *t*.
- **Rendering**: instanced markers below a zoom threshold, and to-scale shapes only when zoomed in.
- **Recording all routes starts in Phase 2**, long before the UI shows them. It costs no extra requests (§4.5), and the per-route statistics (§4.4) cover every route from then on.

### 5.12 Multiple regions

- A **region** record holds the bbox, timezone, agencies and feeds, enabled modes, detail tier and adapters (GTFS-RT, AIS, GBFS).
- **Tiers**:
  1. Track-level rail (the goal everywhere; Vancouver today).
  2. Shape-level schedule (any GTFS; the starting point for a new city).
  3. Live buses (any GTFS-RT).
- Agency quirks (TransLink alert phrasing, GTFS oddities) live behind per-agency adapters, and generic GTFS handling stays generic.
- Track-level work for a new city reuses the whole OSM import → overrides → platform mapping → run inference → dispatcher pipeline. What's new per city is curation: overrides, operations config and OPEN-QUESTIONS. Other signalling systems (fixed block, e.g. the Toronto subway's older lines) need a dispatcher extension.
- **Basemap**: a BC extract of Protomaps' daily build (`pmtiles extract` with a BC boundary) for now, on R2 behind the existing tile worker. It grows to Canada, then Canada + US, then the planet as regions are added. Only the extract's area changes, not the pipeline. Outside the basemap area the map shows "not covered yet", and outside configured regions it shows "transit data not available here yet".
- **Next city**: Montreal (decided, but a long way off). Things to learn before then: the STM's and exo's open data and GTFS-RT terms, whether any metro real-time data exists, and the metro's rubber-tyred rolling stock and signalling (for the dispatcher). The REM is new CBTC. None of this affects the design yet, beyond keeping agency quirks behind adapters.

### 5.13 Trip planning (later)

This comes after the app. Options to evaluate at that point: the Transit app's API (partner terms), a self-hosted OpenTripPlanner 2 or MOTIS fed by our GTFS, GTFS-RT and OSM, or another hosted planner. A self-hosted planner could use our delivered-frequency and live-dispatch data, which is a differentiator, but it's a significant ops cost. Nothing earlier in the plan depends on this choice.

---

## 6. Region-specific data layout

```
regions/metro-vancouver/
  region.json                  # bbox, tz, agencies, feeds, adapters, enabled modes/tiers
  config/                      # kinematics, dwell, turnbacks, rt, seabus, routes/colours
  infrastructure/              # tracks.generated.geojson, overrides.json, seabus.json, diagram-checklist.json
  scenarios/                   # scenario specs + custom geometry
  fixtures/                    # exported observations/disruptions used by tests
```

The skytrain-viz rule applies everywhere: every assumption lives in config with a source or "guess", plus an OPEN-QUESTIONS cross-reference.

---

## 7. Deployment

### 7.1 FullHost

- A **VM in FullHost's Vancouver data centre** (close to TransLink's API and most users). Size TBD from their plans, with roughly 4 vCPU, 8–16 GB RAM and 160+ GB SSD as a starting point. I couldn't read their VM pricing page, so the size and price need checking.
- Docker Compose runs `server` (×1–2), `postgres` (PostGIS image), `caddy`, and backup and monitoring sidecars.
- **FullHost Object Storage** (S3-compatible, data kept in Canada, generally available since June 2026) for archives, backups, private datasets and snapshot exports. Egress pricing needs checking before public files are served from it.

### 7.2 What stays on Cloudflare (decided)

Nothing in this data is sensitive, so we use Cloudflare wherever it helps performance or security:

- **Cloudflare**: DNS, the static site, the CDN and edge cache (including `/rt/live` and immutable build output), WAF and rate limiting in front of `api.transitopia.org`, the tile worker, and **R2** for the tiles and files already there (free tier, working well).
- **FullHost**: the server, PostgreSQL, the 60-day raw data, backups, and the long-term statistics and GTFS archive. New public files can go on either store. Put them where serving is cheapest, and keep the choice a config value so files can move later.

### 7.3 Backups and resilience

- Continuous WAL archiving (WAL-G) or nightly `pg_dump` to FullHost S3, with restores tested quarterly.
- The database backups are what protect the long-lived data (statistics, observed stop times, curated data, reports). Test restores to a scratch VM. Git and the GitHub issues cover the rest.
- With no server, the site shows schedule estimates marked *estimated*, plus a banner.
- Monitoring alerts on **data freshness** (poller age, AIS silence, dispatch lag), not just uptime.

### 7.4 CI/CD

- **PRs**: typecheck, lint, vitest, `validate:infra`, `validate:plan` on a fixture feed, and a web preview deploy.
- **main**: deploy the web; build the server image (GHCR); deploy to the VM (SSH + `docker compose pull && up -d`), running migrations first.
- **Scheduled**: the cycling layer (existing), the basemap refresh, and OSM track-import diff reports. GTFS feed detection and builds run **on the server**, which publishes to object storage.
- **Environments**: production and local dev only for now. Keep staging cheap to add later: all configuration in env files, hostnames and buckets as config, migrations that run unattended, and a compose project name per environment. A future staging environment can then be a second compose project on the same VM (its own database and buckets). Staging **never polls TransLink**: it replays snapshots or reads production's API.

### 7.5 Dev environment with production data

- **Dev machines never poll TransLink.** With a 1,000/day budget per key, one developer's local server would use up production's. By default, local dev reads production's public `/rt/*` endpoints (forwarding, as skytrain-viz's follower mode does now) or replays a snapshot. Polling locally needs an explicit flag and a separate dev API key, if TransLink issues one.
- `npm run snapshot:pull -- --region metro-vancouver --from 2026-09-20 --to 2026-09-27 [--private]`:
  - downloads raw files for that range from object storage (the last 60 days only; older periods have statistics and observed stop times but no raw fixes);
  - restores a **DB snapshot** built nightly by a job: every table except users, sessions and raw IPs, with reporters pseudonymised;
  - fetches the matching GTFS feeds and build outputs.
- **Public snapshots** include only datasets marked `publishable` (§10.3), and anyone can pull them anonymously. **Private snapshots** (e.g. data whose license forbids republishing) need team credentials.
- The server has `SNAPSHOT_MODE=replay`, which feeds recorded data through the live pipeline at real or accelerated time, so live features can be developed against real days (this generalises `eval-rt`).

### 7.6 Analytics

Privacy-friendly analytics (decided): no cookies, no personal data, and no cross-site tracking.

- **To start**: Cloudflare Web Analytics. It's free, cookieless, and nothing to run, since we're already on Cloudflare.
- **Later**: if we need custom events (which modes and panels get used, how far people scrub the time slider, report funnel), self-host **Umami** on the FullHost VM with its own Postgres database. Events carry no identifiers.

### 7.7 Domains

| Host | Serves |
|---|---|
| `www.transitopia.org` | SPA |
| `map-tiles.transitopia.org` | Basemap, cycling, frequency and (later) annotation tiles |
| `data.transitopia.org` | Public immutable build output and public archives |
| `api.transitopia.org` | FullHost VM (behind the CDN under option (a)) |

---

## 8. Mobile app (tentative: Capacitor)

**Capacitor** wraps `apps/web` in a native iOS/Android shell with native plugins (background location, push, share, offline storage). The main reason: our core is MapLibre GL JS plus a custom JS WebGL layer and pure-JS playback. React Native's MapLibre bindings wrap the native SDK, which can't run those without a rewrite. We'll review this in detail before Phase 7.

Things to respect now so the app stays easy later: token auth for the API (no cross-origin cookie reliance), bottom-sheet panels, touch targets ≥ 44 px, and no hard dependence on hover.

---

## 9. Phases

Each phase ends deployed.

**Phase 0: Merge the repos**
- Import skytrain-viz with its full history, create the workspaces layout, unify tooling and CI, merge the CLAUDE.md files, MIT license.
- Done when both apps run locally and every skytrain-viz test and validator passes in the new layout.

**Phase 1: New shell, Protomaps basemap, static transit**
- The site moves to the Protomaps basemap and `map-style` (light and dark). The cycling styling is re-tuned, with before/after screenshots. Walking is removed.
- `/transit` mounts the engine with React controls and inspect. It uses schedules only, with buses marked *estimated*.
- The dataset registry and the dynamic attribution control (§4.6), with TransLink's legend whenever transit is visible. Cloudflare Web Analytics.
- Done when it's live, checked at station zoom (Waterfront, Columbia/Sapperton, Commercial–Broadway, Lougheed, Edmonds, Bridgeport) and on phones, and the cycling map is at least as good as before.

**Phase 2: Server, PostgreSQL, live data → parity**
- Provision the FullHost VM, Postgres, Caddy, backups and monitoring.
- Port the RT service: advisory-lock leader, **budgeted polling** (§4.5) with its hard cap, recorder → 60-day raw tables and files, changes and alerts, AIS, live dispatch. **Record all bus routes.** Local dev forwards to production (§7.5).
- The nightly statistics job and observed stop times (§4.4) start as soon as recording does, since raw data older than 60 days is gone.
- Move observations and disruptions into the DB with states, previews and export. Build the `/admin` disruption and preview UI.
- Import the local history (`rt-history`, `ais-history`, `dispatch-history`). Add snapshot pull.
- **Parity** is reached when everything skytrain-viz does locally works on transitopia.org.

**Phase 3: Details panels**
- Vehicles, with our own fleet records and the admin tool that checks them against CPTDB (§5.3).
- Stations: OSM facts, elevator status history, curated photos.
- Per-stop frequency graphs.
- Route pages with the first long-term statistics (on-time, cancellations, delivered frequency).

**Phase 4: Frequency map**
- Segments, scheduled p90 scores every 30 min, tiles and legend, the time slider hook-up, and click breakdowns. Delivered scores follow once there are a few weeks of all-route recording.

**Phase 5: Reports, submissions, annotations**
- GitHub login and GitHub App, the data repo with issue forms, the anonymous queue, sync, photo uploads, the annotation taxonomy and layer.

**Phase 6: Micromobility**
- GBFS pollers (after license checks), cycling-mode layers, availability history.

**Phase 7: All buses**
- Chunked plans, tiled live snapshots, lazy profiles, instanced rendering.

**Phase 8: Mobile app**
- Capacitor review, then the app, track recording and push alerts.

**Phase 9: Trip planning**
- Evaluate reuse versus self-hosting, then integrate.

**Phase 10+: The next city** (a Canadian one first), starting at tiers 2–3 and working toward track-level.

### 9.1 Continuous: data quality and performance

These run in every phase, not as a phase of their own:

- **Nightly quality report** (a job that publishes a page in `/admin`, and maybe publicly). It covers:
  - `validate:infra` and `validate:plan` results: conflicts, dispatch delay p95, broken deadlocks;
  - bus prediction error (the `eval-rt` metrics on yesterday's data);
  - AIS match rate;
  - share of vehicles *observed* versus *estimated*;
  - feed freshness and poller gaps;
  - OSM import diffs affecting our infrastructure;
  - open data issues by age.
- **Performance budgets**, enforced in CI where possible: JS bundle size per route, time to first vehicle, frame time at 300 and 1,500 vehicles (the screenshot/Playwright tooling measures this), `/rt/live` payload size, and API p95 latency.
- **Ground-truth programme**: ride-alongs and recorded tracks resolve OPEN-QUESTIONS items. Each resolved item updates config with its source.

---

## 10. Licensing

*Guidance, not legal advice.* The main constraints come from OpenStreetMap and from each upstream source's terms.

### 10.1 Code

**MIT** for the whole repo (decided). skytrain-viz is already MIT.

### 10.2 Our data: ODbL (decided)

The options we compared:

| | **CC BY 4.0** | **ODbL 1.0** |
|---|---|---|
| What it asks of users | Credit Transitopia. Anything else is allowed, including closed or commercial reuse. | Credit, **and** if they publicly use a modified or derived *database*, share it under ODbL ("share-alike"). "Produced works" (maps, images, reports) only need attribution. |
| Who reuses easily | Cities, consultants, journalists, researchers, apps. There's almost no friction. | Open projects. Some organisations avoid share-alike data. |
| Mixing with OSM | CC BY data can go *into* an ODbL database. OSM only accepts CC BY 4.0 data with a signed attribution waiver. | Same license as OSM, so it combines freely with OSM-derived data. |
| Protects against | Nothing. A company can take it and improve it privately. | Enclosure: improvements to the database must stay open. |

**The constraint that decides part of this**: anything **derived from OSM** is a *derivative database* of OSM, and if we publish it, it **must be ODbL**. That covers our track graph (OSM import + overrides), OSM-derived station facts, the cycling layer data, and the basemap. So part of our data is ODbL whatever we choose.

**Decision: ODbL wherever we can, including our own content. No dual licensing.** One license for all our data, the same as OSM's, is simplest to explain and keeps improvements open.

| Dataset | License |
|---|---|
| OSM-derived: track infrastructure, station facts from OSM, cycling layer, basemap tiles | **ODbL** (required) |
| Our own content: annotations, our station facts, observations and disruptions, fleet records, frequency scores, per-route statistics, observed stop times *(subject to TransLink's terms, §10.3)* | **ODbL** |
| Photos we host | Chosen per photo by the uploader: **CC BY 4.0 or CC BY-SA 4.0** (both accepted by Wikimedia Commons). Photos are creative works, not databases, so ODbL doesn't fit them. |
| Third-party data we republish (TransLink, GBFS, AIS) | **Their terms**, never relicensed |

Under ODbL, the individual *contents* of a database are usually released under the Database Contents License (DbCL), as OSM does. Every export carries "© Transitopia contributors, ODbL 1.0" plus the credits of any third-party data it contains.

Statistics we derive from TransLink's feeds are our own analysis, but dervied from TransLink data.

**Contributor terms** (shown in the report and upload forms and in the data repo's CONTRIBUTING, accepted with each submission): submitters grant Transitopia a perpetual, irrevocable, worldwide license to use their contribution, to publish it under ODbL, and to relicense it later under another open license, so the choice stays reversible. Photos are the exception: the uploader's chosen CC license applies to them.

Ground facts people report ("this stop has no shelter") can be verified and added to OSM by a mapper, whatever license they came in under.

### 10.3 Per-source terms (register to keep in `docs/data-sources.md`)

| Source | What I found | Publishable? | Action |
|---|---|---|---|
| **TransLink Open API** (GTFS static, GTFS-RT) | [Terms of use](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use): a "limited, revocable and non-exclusive license to use, reproduce, and redistribute the Data". Required legend: "Some of the data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service." No use of TransLink's trade-marks. Revocable on 10 days' notice. Extra terms may apply to commercial users who charge a fee. **"Your API Key will authorize you to offer a maximum of 1,000 requests per day"**, and nothing says whether this applies to GTFS-RT. | Redistribution is allowed with the legend. Archives aren't mentioned either way. | **Decided:** stay within 1,000 requests a day (§4.5) until TransLink replies to our pending request for higher limits. (Also TODO: ask them if publishing recorded history and derived statistics is fine; whether they can share a fleet roster and SkyTrain data; whether a separate dev key is possible.) |
| **OpenStreetMap** | ODbL 1.0 | Yes, as ODbL with "© OpenStreetMap contributors" | Attribution in the map. Our OSM-derived datasets are ODbL. |
| **Protomaps basemap** | Tiles derived from OSM (ODbL). The Protomaps software is BSD-licensed. | Yes | OSM attribution (plus Protomaps credit). |
| **aisstream.io** | Terms not checked (their terms URL 404'd) | Unknown | Check the terms before public launch of archive downloads. Live display is what we do today. |
| **AIS data itself** | Vessel broadcasts are public, but the aggregator's terms govern redistribution | Unknown | As above |
| **CPTDB Wiki** | Community content under **CC BY-SA** (per search results) | Not applicable: we don't republish it | **Decided: checking only.** A person looks things up to verify our own records. We don't scrape it, copy tables from it, or seed our data from it, so its terms don't carry into our data (§5.3). |
| **Wikimedia Commons photos** | Per file (CC BY, CC BY-SA, PD, …) | Per file | Store the license, author and source URL per photo, and display them. Picked by hand only. |
| **Mobi GBFS** | Mobi publishes a GBFS feed. Its trip history files use a separate "Mobi Data License Agreement". The GBFS feed's own license should be in `system_information.json`. | Check | Read `license_id` or `license_url` before archiving publicly. |
| **Other scooter and e-bike operators (Lime etc.)** | Per operator. Some restrict republishing vehicle-level data. | Check | Same as Mobi |
| **City open data** (Vancouver, etc.) | Usually the Open Government Licence – Vancouver (or similar) | Usually yes with attribution | Per dataset |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The **TransLink request limit** (1,000/day) makes live buses less accurate (fixes 1–5 min apart) | A budget weighted to peak hours (§4.5), measured with `eval-rt --subsample`. Honest provenance in the meantime. Ask TransLink for more. |
| Raw data is deleted after 60 days, so a statistic we didn't think of can't be computed later | Keep observed stop times indefinitely (§4.4). Start the statistics job with recording. Catch-up runs on startup, and a job failure alerts well before the 60 days are up. |
| TransLink's license is revocable on 10 days' notice | Keep a good relationship: attribution, no trade-mark use, share findings. The static-first design degrades to schedules. |
| One VM is a single point of failure | Static-first design, freshness monitoring, and tested database restores (§7.3). |
| Browser performance with all buses on phones | Viewport-limited prediction, instanced markers, per-route chunks, performance budgets in CI. |
| Abuse of anonymous reports | Nothing is published without admin review. Rate limits, captcha, hashed IPs. |
| Privacy of recorded tracks and accounts | Trimmed endpoints, no raw tracks tied to a person, deletion, minimal PII. GitHub login means no passwords. |
| Scope: a long feature list for a small team | Strict ordering (§0), each phase ships, continuous quality work instead of big rewrites. |
| Retuning the cycling style on the new basemap | Before/after screenshot comparison in Phase 1. |
| FullHost is less widely used than the big clouds (tooling, egress pricing, S3 compatibility quirks) | Test WAL-G, rclone and PMTiles range requests against their S3 early in Phase 2. Keep everything in portable Docker/S3 terms. |

---

## 12. Open questions

1. **GitHub data repo** (pending): its name, and whether it mirrors shareable datasets as well as issues. Revisit once the per-source checks (§10.3) show what we can publish.
2. **Polling schedule** (accepted for now): revisit when TransLink replies about the request limit.
