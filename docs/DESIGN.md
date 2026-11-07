# Transitopia: design

How Transitopia fits together, and the decisions behind it. Each part has its own document:

| Part | Design |
|---|---|
| The website (`apps/web`) | [apps/web/README.md](../apps/web/README.md) |
| The server (`apps/server`) | [apps/server/README.md](../apps/server/README.md) |
| The database (`packages/db`) | [packages/db/README.md](../packages/db/README.md) |
| The transit engine (`packages/transit-core`): track graph, run inference, dispatcher, buses, SeaBus AIS | [packages/transit-core/DESIGN.md](../packages/transit-core/DESIGN.md) |
| The transit engine on the map (`packages/transit-map`) | [packages/transit-map/README.md](../packages/transit-map/README.md) |
| Pipelines and validators | [pipelines/README.md](../pipelines/README.md) |
| The SkyTrain: what we know about how it runs, and what we don't | [config/networks/skytrain/README.md](../config/networks/skytrain/README.md), [OPEN-QUESTIONS.md](../config/networks/skytrain/OPEN-QUESTIONS.md) |
| TransLink's SeaBus, West Coast Express and buses | [config/feeds/translink/README.md](../config/feeds/translink/README.md), [OPEN-QUESTIONS.md](../config/feeds/translink/OPEN-QUESTIONS.md) |
| BC Transit's systems | [Greater Victoria](../config/feeds/bc-transit-victoria/README.md), [Central Okanagan](../config/feeds/bc-transit-kelowna/README.md), [Fraser Valley](../config/feeds/bc-transit-fraser-valley/README.md), [Vancouver Island](../config/feeds/bc-transit-vancouver-island/README.md), [Sea to Sky](../config/feeds/bc-transit-sea-to-sky/README.md), [Sunshine Coast](../config/feeds/bc-transit-sunshine-coast/README.md), [Thompson–Cariboo](../config/feeds/bc-transit-thompson-cariboo/README.md), [Okanagan–Shuswap](../config/feeds/bc-transit-okanagan-shuswap/README.md), [Kootenays](../config/feeds/bc-transit-kootenays/README.md), [Northern BC](../config/feeds/bc-transit-northern-bc/README.md) |
| Hosting, deployment and operations | [deployment/README.md](../deployment/README.md) |
| Data licenses and sources | [DATA-LICENSES.md](../DATA-LICENSES.md) |

Planned work is tracked in [GitHub issues](https://github.com/transitopia/transitopia/issues), grouped by milestone.

## Goals and scope

Transitopia is one site with **transit** and **cycling** modes, backed by a long-running server in Canada and a PostgreSQL database for everything we collect and curate.

- **Cycling**: the cycling and micromobility map of British Columbia, built from OpenStreetMap by our own pipeline ([packages/cycling-core](../packages/cycling-core/README.md)).
- **Transit** (Metro Vancouver, with BC Transit's buses in Greater Victoria, Kelowna and the Fraser Valley to keep the design [multi-feed](#feeds-operators-and-rail-networks)): Our goal is to show every transit mode in real-time on a single map. Currently we show express buses and SeaBus using accurate real-time data, and we do our best to model SkyTrain and West Coast Express based on their schedule. The web app features a time slider covering past, live and projected future service. Corrections, disruptions, scenarios and a signalling-aware dispatcher refine the schedule where possible.
- **Walking** is planned for the future.

Some upcoming priorities, in order: details panels, the frequency map, submissions and annotations, micromobility, all buses, a mobile app, and trip planning. Data quality and site performance improve continuously alongside all of these. The long-term goal is SkyTrain-level detail in other cities, one city at a time: Vancouver first, Montreal next.

Desktop-first, but the map and time controls must work on phones, with minimal chrome.

## Principles

1. **Positions are a pure function of (plan, overlays, t).** No frame-stepped state in the client. This is what makes seeking, rewinding and fast-forwarding work, and it applies to every mode we animate.
2. **Provenance everywhere.** Vehicles carry `observed | interpolated | estimated` and a source. Curated facts carry a source and a date. Never present an estimate as fact.
3. **Upstream APIs are polled centrally,** within each provider's limits and on an explicit request budget ([below](#upstream-request-budget)). Client requests never trigger calls to TransLink, aisstream.io or OSM, and neither do development machines.
4. **Shared state is computed centrally.** The dispatcher and disruption parsing run on the server or at build time, and every visitor sees the same versioned result.
5. **Secrets never reach the browser or the app bundle.**
6. **Infrastructure is data.** OSM first, fixed upstream where possible. Our own fixes are reviewable data (`config/networks/*/infrastructure/overrides.json`).
7. **Nothing untrusted reaches the public map or the dispatcher without review.** Drafts can be previewed, but only confirmed inputs are published ([below](#corrections-and-previews)).
8. **Static first, dynamic where needed.** Anything that can be an immutable file behind a CDN is one. The server handles live data, writes and moderation. If the server is down, the site degrades to schedule estimates instead of breaking.
9. **Licensing is tracked per dataset** ([DATA-LICENSES.md](../DATA-LICENSES.md)). Every dataset records its source and license, and publishing respects them.
10. **Every assumption is config.** Operating assumptions live in config (a rail network's, a feed's, an operator's or `config/defaults/`) with a source or "guess", and a cross-reference to the matching open question. No magic numbers in code. Every config file has a schema (`packages/transit-core/src/config.ts`), checked wherever it's loaded, so a mistyped setting fails instead of reading as undefined.

## Architecture

```
                         ┌─────────────────── Cloudflare (DNS, CDN, WAF, R2) ──────────────────┐
 Browser ──────────────▶ │ www.transitopia.org        static SPA (Pages, from the prod branch) │
                         │ map-tiles.transitopia.org  basemap, transit overview (worker on R2) │
                         │ data.transitopia.org       transit and cycling build output (R2)    │
                         │ api.transitopia.org ─┐     proxied; live poll edge-cached ≤ 10 s    │
                         └──────────────────────┼──────────────────────────────────────────────┘
                                                ▼
                         ┌───────────── FullHost VM, Toronto (Docker Compose) ──────────────┐
                         │ server (Node/TS, Hono)                                           │
                         │  ├ API: /feeds/<id>/live, /networks/<id>/live/dispatch,          │
                         │  │      per-date files (AIS, changes), /rt/*, /healthz,          │
                         │  │      /auth (GitHub), /admin/api                               │
                         │  ├ leader (pg advisory lock): GTFS-RT within the budget, AIS,    │
                         │  │      alerts, recorder, live dispatcher                        │
                         │  └ jobs: partitions, retention, statistics, data build, archive  │
                         │ PostgreSQL + PostGIS · Caddy (TLS) · nightly backups             │
                         └──────────────────────────┬───────────────────────────────────────┘
                                                    ▼
                         Cloudflare R2: transitopia-data (public build output) and the
                         private transitopia-archive (backups, raw recordings, GTFS feeds)
```

The transit data a browser needs (service plans, track network, platform mapping, dispatched movements, dispatch patches) is a static build. The server builds and publishes it daily, because a live dispatch patch only fits the build it was dispatched against. Live data (bus positions, AIS fixes, service changes, live dispatch versions) comes from the server's small, edge-cached endpoints. Without the server, the site shows the static build: schedule estimates, marked *estimated*.

## Repository layout

npm workspaces. Cross-workspace imports use package specifiers (`@transitopia/transit-core/time.ts`); imports inside a workspace stay relative.

```
apps/web/                  the site (React SPA): modes, the shared map, transit controls, /admin
apps/server/               the server: real-time API, leader (pollers, recorder, live dispatch), jobs, admin API
packages/transit-core/     DOM-free engine: GTFS, track graph, run inference, dispatcher, playback, corrections, RT prediction
packages/transit-map/      the engine on a host MapLibre map: clock, playback, WebGL layers; no UI framework
packages/map-style/        the Protomaps basemap style (light and dark), zoom helpers
packages/cycling-core/     DOM-free cycling map logic: OSM classification, chains, the cycling tiles' schema
packages/data/             Node-side data access for pipelines and the server: where data lives (paths.ts), GTFS zips, disruption files, dispatch contexts
packages/db/               PostgreSQL: SQL migrations, Kysely types, partitions, jobs
packages/shared/           shared by web and server: the dataset registry
pipelines/                 build-time pipelines and validators
config/                    committed, curated inputs: defaults/, operators/, feeds/, networks/ (Feeds, operators and rail networks, below), cycling/
infra/                     production Compose stack, server image, Caddy, backups, firewall; the local database
deployment/                setup and operations notes, the tile worker
var/                       gitignored: downloads, recordings, build output (var/public is the transit data's web root)
```

## Where data lives

| Data | Where | Kept |
|---|---|---|
| Scenarios, infrastructure overrides, operations config | Git (`config/networks/`), checked by the validators | |
| Observations and disruptions | Database, with review states and an export to the file format in `config/feeds/*/observations/` and `config/networks/*/disruptions/` ([below](#corrections-and-previews)) | indefinitely |
| Raw real-time data: GTFS-RT positions and AIS fixes | Database (partitioned by day) and hourly NDJSON.gz files, copied to the archive bucket | **60 days** |
| Observed stop times per trip and stop | Database (partitioned by month) | indefinitely |
| Per-route daily statistics | Database (`route_stats_daily`) | indefinitely |
| Trip changes (cancellations, skipped stops), alerts with first and last seen, dispatch versions | Database (and files) | indefinitely |
| GTFS static feeds | Archive bucket (the original zips) and `gtfs_feeds` | indefinitely |
| Feature registry: IDs, refs, containment, flags, admin changes ([below](#feature-ids)) | Database (`features`, `feature_refs`, `feature_flags`, `feature_changes`) | indefinitely |
| Request ledger (`upstream_requests`) | Database | |
| Published transit data (plans, movements, patches) | `transitopia-data` on R2, behind data.transitopia.org | |
| The cycling map's OSM file (what osmium keeps of the BC extract) | `transitopia-data` on R2 (`data/osm/`), published by GitHub Actions | two weeks |
| The cycling map's tiles | `transitopia-data` on R2 (`data/cycling/`), published by the server's data build | two weeks after the index stops naming them |
| Bike routes (from the cycling build) | Database (`cycling_routes`, `cycling_route_members`), replaced by each build; their IDs in the registry | the latest build |

Tables and migrations are described in [packages/db/README.md](../packages/db/README.md).

## Retention and statistics

Raw real-time data is deleted after 60 days (`config/server/recording.json`). Any statistic we haven't computed by then can never be computed for that period, so:

- **Observed stop times are the atom.** From each vehicle's fixes we derive, per trip and stop, the observed (interpolated) arrival and departure, its precision (the time between the fixes it came from), and the scheduled time. Nearly every statistic can be recomputed from them, including ones we haven't thought of yet. They're kept indefinitely.
- **A daily job** computes statistics for each finished service date while the raw data is still there, and catches up after downtime: per route, direction, day and time band, trips scheduled, observed and cancelled, skipped stops, on-time performance at timepoints (on time = **1 minute early to 3 minutes late**), delay percentiles, delivered versus scheduled headways, and bunching. `npm run stats -- <YYYYMMDD>` recomputes a date.
- **Coverage is the denominator.** Every statistic records how much of the period the recorder covered. "Cancelled" and "on time" only mean something where we were recording; gaps are reported as gaps, never as zeros.
- **Statistics are versioned.** Each row records the version of the code that produced it, so a changed definition can be recomputed from the atom.
- **Every route is recorded,** not just the ones drawn. Each response already covers every TransLink vehicle, so this costs no extra requests, only storage. Vehicles on routes not drawn when they were recorded (excluded ones, or routes before every route was drawn) get an untracked route key (`gtfs:<route_id>`); every reader keeps only tracked ones (`trackedOnly`), giving a vehicle on a route drawn since then that route's key, so older recordings count it too.

Kept in Postgres, observed stop times grow by about 73 GB a year across the three feeds ([deployment/README.md → Sizing](../deployment/README.md#sizing)), so older months need to move to monthly files in object storage before mid-2027.

## Upstream request budget

Every feed is polled within a budget of its own (`config/feeds/<feed>/feed.json` → `realtime.poll`: a daily cap and a time-of-day schedule), whatever its provider allows. TransLink's terms give an API key "a maximum of 1,000 requests per day". Until TransLink approves more, the leader stays under that across `gtfsposition`, `gtfsrealtime` (trip updates) and `gtfsalerts`, polling more often at peak and less off-peak:

| Weekday band | Positions | Trip updates | Alerts |
|---|---|---|---|
| Peak: 06:30–09:30, 15:00–18:30 | every 60 s | every 4 min | every 20 min |
| Day and evening: 05:00–06:30, 09:30–15:00, 18:30–23:00 | every 150 s | every 10 min | every 30 min |
| Night: 23:00–05:00 | every 5 min | every 30 min | hourly |

Weekends have their own, flatter schedule with a midday peak. Together they stay at about 970 requests in any 24 hours. BC Transit's feeds need no key and state no limit. Victoria and Kelowna are polled every 30 s for positions, 2 minutes for trip updates and 5 for alerts while buses run (less overnight), about 3,500 requests a day, with a cap of 4,000. Its other systems default to every 2 minutes for positions and trip updates (the Fraser Valley: about 1,500 requests a day, with a cap of 2,000; `config/operators/bc-transit/operator.json`).

- **Hard cap**: a ledger per feed (`upstream_requests`) counts every attempt, including failures. The poller stops at the cap, error backoff is long because it spends budget, and a restarted leader resumes each feed's schedule instead of polling at once.
- **One poller**: only the leader polls (a Postgres advisory lock), so there's one counter. Other instances forward `/rt/*` to it.
- **Only production polls.** The key's budget is shared, so a server polls only with `RT_POLL=1`, keyless feeds included. Local development forwards to production (`RT_FORWARD_TO=https://api.transitopia.org`), points the site straight at it, or uses snapshots of production data ([deployment/README.md → Snapshots](../deployment/README.md#snapshots-for-development)).
- **Effect on quality**: fixes come 1–5 minutes apart instead of ~30 s. Thresholds that depend on the cadence (stale data, coverage gaps, "observed" windows, prediction limits) follow the interval in use (`packages/transit-core/src/rt/budget.ts`). `npx tsx pipelines/eval-rt.ts --subsample schedule` replays recorded history as if polled on the schedule.

Other providers get budgets under their own terms. aisstream.io allows 3 connections per account: production's leader holds one WebSocket, which leaves room for `pipelines/probe-ais.ts` and the occasional local test.

## Corrections and previews

Observations (sightings of a train or vessel at a stop at a time, consists, cancellations) and disruptions (single-track sections, reduced headways for a period) refine the schedule. The engine side is in [packages/transit-core/DESIGN.md → Corrections](../packages/transit-core/DESIGN.md#corrections) and [→ Disruptions and alerts](../packages/transit-core/DESIGN.md#disruptions-and-alerts).

- In production they live in the database, each with a review state: `draft → previewing → confirmed | discarded`. The server drafts disruptions from TransLink alerts; admins edit them at `/admin`.
- **Preview**: an admin dispatches the dates a draft touches (within a week of today) with the draft added. The result is a **preview version**: an immutable dispatch patch like any other, but not advertised by the live endpoint. `/admin` links to `/transit?preview=<YYYYMMDD>:<version>`, and the time bar says it's showing unconfirmed corrections. Preview versions hold nothing private, so anyone with the link can see one.
- **Confirm** publishes the input, and the next regular dispatch includes it. A disruption can't be confirmed without saying which track stays open. Editing a confirmed input sends it back to draft.
- Observations are a feed's (they name its trips: `config/feeds/translink/observations/`) and disruptions a rail network's (they name its track: `config/networks/skytrain/disruptions/`). Those files are imported into a new database, and are what local pipeline runs (`npm run data`) read; the server's data build exports the database's confirmed ones for its pipelines instead, laid out the same way (`correctionPaths` in `packages/data/src/paths.ts`). `npm run corrections -- export|import|pull` moves corrections between the two.
- Precedence, shown as provenance: manual observation > live sensor (GTFS-RT, AIS) > confirmed disruption or alert > schedule.

## Attribution

Each dataset has an entry in the registry (`packages/shared/src/datasets.ts`): id, short credit, full legend text, link and license. Every map source, layer and engine component declares which datasets it draws (`useDatasets([...])` in the site), and the site's attribution control (replacing MapLibre's default) credits exactly what's visible: the layers turned on, plus whether the engine is drawing any vehicle from that dataset. On phones it collapses to a short line with an ⓘ button.

Transit data is credited per route, never by naming a provider in UI code: each route in a plan names its feed's dataset (`PlanRoute.dataset`, from `dataset` in its `feed.json`; plans built before it fall back to the feed's, passed to the engine), and a schedule dataset names its provider's real-time companion (`realtime`). The engine's snapshots say which datasets lie behind what's drawn and behind each card (a vehicle, a route, a place's departures, adding the real-time dataset where real positions or predictions are shown), so with several providers each card credits only its own.

Required legends, such as TransLink's ("Some of the data used in this product or service is provided by permission of TransLink. …"), appear in full whenever that data is visible: in the expanded credits and in the footer of each card showing it.

## Feeds, operators and rail networks

Everything committed and curated is under `config/` (one package, `@transitopia/config`), with schemas in `packages/transit-core/src/config.ts`, checked by a test over every committed file:

```
config/
  defaults/        kinematics.json, rt.json: vehicles and real-time use, for every operator
  server/          server.json, recording.json: the server's own (port, live dispatch, retention, statistics)
  features/        reconcile.json: feature reconciliation's distances (#feature-ids)
  operators/<id>/  operator.json: who runs the vehicles (TransLink, BC Transit), and its overrides of the defaults
  feeds/<id>/      feed.json: one agency's published data (GTFS, GTFS-RT, request budget, vessels' AIS,
                   time zone checks), naming its operator; routes.json: overrides and exclusions of its
                   routes, by name; ferries/<route>.json: a ferry route's berths, lanes and default
                   berth pair (the SeaBus, Hullo); for TransLink also observations/; README, OPEN-QUESTIONS
  networks/<id>/   network.json: a rail network (time zone, signalling, OSM area, the feeds whose
                   track-level routes run on it); operations.json, dispatch.json; infrastructure/,
                   scenarios/, disruptions/; README, OPEN-QUESTIONS
```

| Feed (operator) | Where | Drawn |
|---|---|---|
| `translink` (TransLink) | Metro Vancouver | SkyTrain, SeaBus, West Coast Express and every bus route (99 B-Line and R1–R6 RapidBus in their own colours; HandyDART excluded) |
| `hullo` (Hullo) | Vancouver–Nanaimo | Its passenger ferry |
| `bc-transit-victoria` (BC Transit) | Greater Victoria | Every bus route (95 Blink RapidBus in its own colour) |
| `bc-transit-kelowna` (BC Transit) | Central Okanagan | Every bus route (97 Okanagan RapidBus in its own colour) |
| `bc-transit-fraser-valley` (BC Transit) | Fraser Valley | Every bus route of Abbotsford, Mission, Chilliwack, Agassiz-Harrison and Hope, one export |
| `bc-transit-vancouver-island` (BC Transit) | Vancouver Island | Every bus route outside Greater Victoria: Nanaimo, Cowichan Valley, Comox Valley, Campbell River, Port Alberni, West Coast, Mount Waddington, Salt Spring Island; 8 exports merged |
| `bc-transit-sea-to-sky` (BC Transit) | Sea to Sky | Every bus route of Squamish, Whistler and the Pemberton Valley; 3 exports merged |
| `bc-transit-sunshine-coast` (BC Transit) | Sunshine Coast | Every bus route of the Sunshine Coast and Powell River; 2 exports merged |
| `bc-transit-thompson-cariboo` (BC Transit) | Thompson–Cariboo | Every bus route of Kamloops, Merritt, Clearwater, Ashcroft–Cache Creek–Clinton, 100 Mile House, Williams Lake and Quesnel; 7 exports merged |
| `bc-transit-okanagan-shuswap` (BC Transit) | Okanagan–Shuswap | Every bus route of the North Okanagan and Shuswap, the South Okanagan–Similkameen and Revelstoke; 3 exports merged |
| `bc-transit-kootenays` (BC Transit) | Kootenays | Every bus route of the West Kootenay and Creston Valley (not the East Kootenay, in another time zone); 2 exports merged |
| `bc-transit-northern-bc` (BC Transit) | Northern BC | Every bus route of Prince George and the Bulkley-Nechako, Smithers, Terrace–Kitimat–Hazeltons, Prince Rupert, Dawson Creek and Fort St. John (their `America/Dawson_Creek` taken as `America/Vancouver`); 6 exports merged |

| Rail network | Feeds | Track |
|---|---|---|
| `skytrain` | `translink` | The Expo, Millennium and Canada Lines, imported from OSM |

The map shows whichever feeds are in view, so a route that runs from one agency's area into another's (the Fraser Valley's 66 to Lougheed Station, TransLink's West Coast Express to Mission City, Hullo to Nanaimo) is drawn and live wherever it runs. Operators are separate from feeds because one operator publishes many: BC Transit has a feed per transit system. Rail networks are separate from feeds because the two don't map one to one: one feed can run on many networks (VIA Rail), and one network can carry several feeds' trains (shared track). Nothing is keyed by an area in data, URLs or the database.

**Settings come in layers** (`resolveKinematics`, `resolveRt`): the defaults, then the feed's operator's overrides (a mode's vehicle settings; bus prediction and carried delays, which depend on its buses and data), then the feed's own (`feed.json` → `kinematics`, `rt`: one system of an operator with different buses or data), then for vehicles its routes' (`routes.json` → `kinematics`, e.g. a SkyTrain line's train length). Each layer is partial; the result is checked whole, so a misspelled setting in any layer still fails. Vehicles' minimum drawn size is the defaults' alone, so they look alike everywhere. How often a feed is polled, and the thresholds that follow from it, are the feed's own (`feed.json` → `realtime`).

Everything that comes from a feed is keyed by the feed, and happens once however it's shown; what's about physical track is keyed by its rail network:

- **Built** per feed: `var/raw/gtfs/<feed>/<version>/`, published at `data/feeds/<feed>/manifest.json` and `data/feeds/<feed>/<version>/` (plan, movements, platforms, real-time profile); each plan names its feed (`ServicePlan.feed`). The manifest also says where the feed runs (`coverage`: the bbox of every version's stops and shapes), which is how the map knows when to load it. A GTFS `feed_version` becomes a directory name with anything but letters, digits, `.`, `_` and `-` replaced (`versionDir`).
- **Polled and recorded** per feed: one poller each on the server's leader, within the feed's own budget (`feed.json` → `realtime.poll`), and one AIS stream for a feed whose vessels report AIS (`feed.json` → `ais`: TransLink's SeaBus); recordings in `var/rt-history/<feed>/` and `var/ais-history/<feed>/` (archived under the same paths); database rows keyed by `feed_id`. The server's endpoints for recordings take the feed (`/rt/history?feed=<id>`, `/rt/coverage?feed=<id>`), and refuse a request without one.
- A feed's **observations** (sightings of its trips) are published at `data/feeds/<feed>/observations/`.
- What's the **rail network's** is published under `data/networks/<id>/`: its track (`infra/`), dispatch patches (`dispatch/`) and scenarios; its live dispatch is served at `/networks/<id>/live/dispatch` (and as an index at `/networks/<id>/dispatch`), its versions kept in `var/dispatch-history/<network>/` and the `dispatch_versions` table (`network_id`), its disruptions in the `disruptions` table (`network_id`).

**Track-level rail** runs on rail networks: `railNetworks()` in `packages/data/src/paths.ts` lists each network with each feed on it (`network.json` → `feeds`, whose routes of kind `skytrain` run on its track), and the rail pipelines loop over them (or take `--network <id>`). The server's live dispatcher, its corrections and `/admin` support one rail network so far (`railNetwork()`, which fails at startup if there are more), but everything they keep is keyed by its id, so a second network needs only a dispatcher per network. `network.json` → `signalling` says what the dispatcher models (only `moving-block` so far).

Live data is per feed and per rail network, so every view showing a feed shares one cached response: `/feeds/<id>/live` (`vehicles`, `changes`, `ais`) and `/networks/<id>/live/dispatch` (`dispatch`). A feed's service changes are at `/feeds/<id>/days/<date>/changes`, its AIS day files at `/feeds/<id>/days/<date>/ais`. The map polls each feed it shows and each rail network they run on.

Agencies shape their ids differently, so a feed also says how riders see them (`feed.json` → `display`: a regex each for trip ids and versions, whose first group is the short form; `packages/transit-core/src/plan/display.ts`). A vehicle card shows "Trip 08:05 from Langford Exchange · 11898518" (where riders can first board it, and the short id) and "Source: BC Transit timetable (202610140)"; links, observations and recordings keep the full GTFS ids.

**On the site**, `/transit` has one engine, made once and never recreated as the map moves: it loads each feed while the view (plus a margin) overlaps its coverage and unloads it a while after it leaves ([packages/transit-map → Feeds](../packages/transit-map/README.md#feeds)), so the time and the selection simply stay. The site passes every feed in `config/` (`apps/web/src/TransitMap/feeds.ts`, which resolves each with its operator and rail network, so adding a feed is data only). Below z10 (`ENGINE_MIN_ZOOM`) the engine is hidden and paused, and the [overview tiles](../packages/transit-core/DESIGN.md#overview-tiles) show every feed's routes with static colours. The only places the site names are a few views (`apps/web/src/TransitMap/views.ts`: a name and bounds each): where `/transit` opens without a map position (the first), and the "Go to …" box shown where no feed is in view. A station or exchange that two feeds serve (the registry puts both feeds' stops in it) is one card with both feeds' departures.

Feeds have tiers of detail: (1) track-level rail, the goal everywhere and Vancouver today; (2) shape-level schedules from any GTFS, the starting point for a new city; (3) live buses from any GTFS-RT, as in Victoria and Kelowna. Track-level work for a new city is a new rail network, and reuses the whole OSM import (`--network`) → overrides → platform mapping → run inference → dispatcher pipeline; what's new per city is curation (overrides, operations config, open questions). Agency quirks (TransLink's alert phrasing, GTFS oddities) belong behind per-agency adapters, and generic GTFS handling stays generic: BC Transit's feeds needed only generic changes (bay names without `@`, `calendar_dates.txt` without `calendar.txt`, a `feed_version` with slashes). Other signalling systems (fixed block) would need a dispatcher extension.

Service dates are `"YYYYMMDD"` strings typed `ServiceDate` (`packages/transit-core/src/time.ts`), a branded type so they can't be mixed up with ISO dates or other strings: they come from `serviceDate()`/`isServiceDate()` where they enter (GTFS, URLs, requests, the command line), `isoToServiceDate()` for observations' ISO dates, and the time helpers.

The basemap is a British Columbia extract of Protomaps' daily build for now. It grows to Canada, then Canada and the US, then the planet as feeds are added; only the extract's area changes. Outside the basemap the map has no tiles.

Time zones come from the runtime's tzdata, never hard-coded. BC moved to permanent UTC−7 in 2026 (tzdata 2026b); the server refuses to start on older data (`timezoneChecks` in each `feed.json`). Every feed and rail network so far is in `America/Vancouver`, the default in `packages/transit-core/src/time.ts`. The engine works out each feed's service dates in that feed's time zone ([packages/transit-map → Feeds](../packages/transit-map/README.md#feeds)), but the server's poll schedules and recorded hour files still use the default, so `build-schedule` refuses a feed in another time zone until one needs it. A feed can take a zone with the same offsets as its own (`equivalentTimezones` in `feed.json`): BC Transit's Dawson Creek and Fort St. John exports name `America/Dawson_Creek`, which has had `America/Vancouver`'s offsets since BC's change, and `build-schedule` refuses the feed if the runtime's tzdata ever gives the two different offsets on a date of its timetable.

## Feature IDs

Every station, bus exchange, stop and route in every feed, and every bike route, has a **persistent, global ID** that survives GTFS feed changes and renames (issue #193; bike routes, issue #229; vehicles, other cycling features and facts come later: paths and bike parking are named by their OSM refs). The registry is in the database, and only production's IDs are published.

**Two forms of string** name a feature, told apart by their characters alone (`packages/shared/src/features.ts`: `parseKey`, `formatKey`, `mintId`):

| Form | Contains | Grammar | Examples |
|---|---|---|---|
| **ID** | no `:` | `<prefix>-<8 characters>`, optionally `-<name>` | `sn-k3v9qd7m`, `sn-k3v9qd7m-waterfront` |
| **Ref** | `:` | `<scheme>:<value>` or `<scheme>:<namespace>:<value>` | `gtfs-stop:translink:12034`, `stop:translink:50123`, `osm-way:123890` |

- **IDs** are a kind's prefix (`sn` station, `ex` exchange, `st` stop, `rt` route; `vh`, `cr`, `cw`, `bp`, `mm` for vehicles, cycling routes and ways, bike parking and bikeshare stations; `an` and `ph` reserved) and 8 random lowercase Crockford base32 characters, never derived from data. Minting draws again if the ID exists. A **name suffix** after them (`-waterfront`) is decoration for URLs, ignored by lookups, so there are no slugs.
- **Refs** point at a record in a source. The scheme says whether there's a namespace (a feed, operator or GBFS system), so the value can hold anything, `:` included. `gtfs-stop` and `gtfs-route` are the feed's `stop_id` and `route_id`; `stop` is the `stop_code`, the number on the sign. These three hold over a **range of feed versions** (`feature_refs.versions`, an `int4range` of `gtfs_feeds.seq`, the order versions were archived in), so a ref names one feature in each version and a reused id can name another later. `run:<feed>:<run id>` (a vehicle the engine draws without a feature of its own: an inferred SkyTrain run, a timetable vehicle) and `shared:<start key>:<end key>` (a combined route between two stations, exchanges or stops, [packages/transit-core → Combined routes](../packages/transit-core/DESIGN.md#combined-routes)) are the engine's own, never the registry's.

### Features and areas

Nothing in the registry is keyed by an area. Place-bound engineering data (track, dispatch, disruptions) is a rail network's; what a stop or route belongs to is its operator and feed (`features.operator_id`, `feed_id`). A station or exchange can hold several feeds' stops (the Fraser Valley's 66 at TransLink's Lougheed Station), and the map shows it as one place.

### Relationships between features

- **Service** (which routes serve a place) stays derived from the plan: it changes with every feed version and date.
- **Containment** (which station or exchange a stop is in) is the registry's: `features.parent_id`, one level. The heuristics only propose it: the plan's station merging (same name within 400 m, `src/plan/stations.ts` in transit-core) and bay grouping (`groupBays`, [packages/transit-core/DESIGN.md → Bus exchanges](../packages/transit-core/DESIGN.md#bus-exchanges)). A stop's parent is set when it's first minted, and from then on only an admin changes it (`npm run features -- move|detach`, recorded in `feature_changes`), even when it has none. Exchanges are features like stations, with no ref: GTFS has no record of them, so their identity is kept in the registry and new bays join them through their existing bays.

### Reconciliation

Feature reconciliation is the process of matching GTFS features like bus stops to our permanent IDs, like `st-g36cf3hr-50913`, minting new IDs as needed. The server's daily data build reconciles every feed version in `gtfs_feeds` not yet reconciled, oldest first, one transaction each ([apps/server → Feature reconciliation](../apps/server/README.md#feature-reconciliation)). The matcher is pure (`packages/transit-core/src/features/reconcile.ts`: registry snapshot + the version's every stop and route → decisions), with its distances in `config/features/reconcile.json`:

| Kind | The same feature when (first match wins) | Otherwise |
|---|---|---|
| stop | 1. its `stop_id`'s ref, with the same `stop_code`; 2. its `stop_code`'s ref; 3. without a code, an unmatched stop of the same name within 50 m; 4. another feed's stop that's the same physical stop ([below](#shared-stops)) | Mint. Flag it beside a stop that disappeared (`disappeared-nearby`); flag a matched stop that moved over 300 m (`code-moved-far`). |
| station | a ref of a parent stop in its group (parent stops and standalone rail stops of the same name, merged as the plan merges them); else an unmatched station of the same name within 300 m in the feed | Mint. Flag it when another feed has a station of the same name within 300 m (`cross-feed-name-match`). |
| route | the same feed and name (`route_short_name` without leading zeros, else `route_long_name`); in a feed keyed by `route_id` (`feed.json` → `routeKey`), its `gtfs-route` ref | Mint. |

A new stop gets its parent from the proposal: a platform its GTFS parent's station; a bay the parent most of its group's existing stops have, "none" included (so a new bay at an exchange an admin dissolved stays an ordinary stop); and only when every stop of a group is new, the station the group is beside, another feed's exchange of the same name ([Shared stops](#shared-stops)), or a newly minted exchange (flagged `exchange-replaced` beside an exchange of its own feed that lost all its stops). An existing stop whose parent differs from the proposal is flagged (`grouping-differs`) and kept. A retired stop or station whose `stop_id` or stop code comes back is made active again and flagged (`retired-returned`): retiring one means it's gone, and the feed says it isn't. A feature is flagged once per reason. Names and positions follow the newest version, except where an admin set them.

### Shared stops

A stop several feeds serve is one feature with refs in each (issue #266): TransLink's and the Fraser Valley's Bay 1 at Carvolth Exchange is `st-cetfp8g4`, with `stop:translink:61709` and `stop:bc-transit-fraser-valley:120054`. Two stops of different feeds are the same (`sharedStopMatch` in `packages/transit-core/src/features/reconcile.ts`, distances in `config/features/reconcile.json`):

- **One operator's feeds** (BC Transit's merged feeds repeat its stops: 100076 is in both `bc-transit-victoria` and `bc-transit-vancouver-island`): the same stop code within `sharedStopCodeM` (150 m; its depots share a placeholder code hundreds of km apart). Its codes are its own, so two of its codes are two stops however close.
- **Different operators**: within `sharedStopM` (10 m), unless both are bays with different numbers. Each such match is flagged (`shared-stop`) for an admin to check.

Never two stops of one feed. A new stop that matches takes the other's feature (reconciliation's rule 4), and after every reconciliation `mergeSharedStops` (`apps/server/src/features/registry.ts`) merges stops minted apart (before the rule, or before the other feed's twin existed) into the one seen first (by the first feed version of its refs), recorded in `feature_changes` like an admin's merge. The merged stop stays in its station or exchange, or takes its twin's when it had none (unless an admin left it in none); where the two were in different ones it's flagged `grouping-differs`. A stop's `feed_id` and `operator_id` are its **home feed**'s, the one it was first minted from: only its versions set the stop's name and position.

**Exchanges** work the same way, by name: a feed's group of new bays joins another feed's exchange of the same name within `exchangeMatchM` (250 m) rather than minting its own, and `mergeSharedExchanges` (run first) merges exchanges of the same name that close, with stops from different feeds, into the one with the most stops (Westbank and UBCO exchanges had been minted once by Kelowna's feed and once by Okanagan-Shuswap's). An exchange's name and position follow the feed most of its stops are from.

Each feed's places file names the stop by the same ID (with that feed's code as its suffix), so the site shows one card for it: both feeds' departures and routes, and every number on its sign ("Stop #120054 (BC Transit), #61709 (TransLink)"; [packages/transit-map → Feeds](../packages/transit-map/README.md#feeds)). The map draws it once, as its home feed has it (its name and position: the feeds' copies can differ by a few metres and in wording, "Innovation Dr at University Way" and "Innovation Dr & University"): each places file names the home feed of the stops it shares whose home is another feed (`homes`), and the engine filters out the other feeds' copies while that feed is loaded, else every copy but the first loaded feed's (`sharedStopOwners` in `packages/transit-map/src/plans.ts`).

### OSM bus stops

A stop's OpenStreetMap node is the `highway=bus_stop` node whose `ref` (the number on the sign; several separated by `;`) is the stop's code, the nearest within `matchM` (150 m, `config/features/osm-stops.json`): `matchOsmStops` in `packages/transit-core/src/features/osm-stops.ts`. Matched by code only, since a nearby node without it may be the stop across the street; a node two stops of a feed match goes to the nearer. `fetch-osm-roads` saves each feed's nodes beside its roads (`bus-stops.json`, from the same Overpass query). In November 2026 about 70% of the feeds' stops matched (none of the Kootenays', whose nodes have no refs).

- **Bay letters**: where neither the GTFS nor the name gives a bay its number, `build-schedule` takes the node's `local_ref`, else the letter or number its name ends with ("Downtown Exchange A", "… Exchange Bay F"), as the plan stop's `platform`. Okanagan-Shuswap's Downtown Exchange in Vernon is seven stops all named "Downtown Exchange"; OSM letters them A–G. Not where the name already says what the bay is ("22nd Street Station @ Unloading Only").
- **`osm-node:` refs**: after reconciling, `linkOsmStops` (`apps/server/src/features/registry.ts`) gives each stop of the feeds' newest versions its node as an unbounded ref. A node stops of two features match (twins not yet merged) gets none; a ref that no longer matches is removed, unless an admin added it or the stop is also in a feed whose OSM stops weren't fetched. The resolver then answers `osm-node:<id>` with the stop, so `?select=osm-node:<id>` opens its card; the stop card asks the resolver for it and links to the node ("View or edit on OpenStreetMap"). Not in the plan: every stop's node would add 7% to TransLink's.

### Published features

The site resolves IDs from published files, without the server (principle: static first):

- **`plan.json` holds no IDs**: it stays a pure function of GTFS and config. A rebuilt plan would need its movement files rebuilt and the day's dispatch patches re-dispatched, and registry edits have to show up within minutes.
- **A places file per feed version**, `data/feeds/<feed>/<version>/places.<n>.json` (`PlacesFile` in `packages/shared/src/features.ts`, built by `buildPlaces` in `packages/data/src/features.ts`): for the plan's own ids (station ids, `stop_id`s, route keys) their features' keys (IDs with name suffixes), each stop's station or exchange, those places' names and positions, and redirects from merged IDs. `<n>` goes up whenever the content changes, so every file is immutable; `data/feeds/<feed>/places.json` (5-minute cache, like the manifest) names each version's current one. The server writes them after reconciling, and again within one job tick of an admin change (the `places` job), without rebuilding any plan.
- **The public export**, `data/features/export/<YYYYMMDD>.ndjson.gz`, with `data/features/latest.json` pointing at the newest: every feature (merged ones too, for redirects), its refs, and the feed versions their ranges are over. No authors, users or flags. `npm run features -- pull` loads it into a development setup.
- **The resolver**, `GET https://api.transitopia.org/features/<key>` ([apps/server → Feature resolver](../apps/server/README.md#feature-resolver)), for what the loaded places files don't have: a feature of a feed not loaded (its bbox moves the map there, and the feed loads). Cached for an hour at the edge.

`?select=<key>` on `/transit` names whatever's selected, a place, route or vehicle, in either form ([apps/web → Modes and URL state](../apps/web/README.md#modes-and-url-state)); on `/cycling`, a bike route by its `cr` ID, and a path or bike parking by its OSM ref ([apps/web → Cycling links](../apps/web/README.md#cycling-links)). Bike routes aren't in published files: the server answers for them from the database ([apps/server → Cycling routes](../apps/server/README.md#cycling-routes)). A key of the other mode goes to that mode. Older URL forms aren't read (there were few users: nothing from before keeps working).

**Statistics** keep their GTFS keys and record the feed version they were derived from (`feed_version`); the views `route_stats_daily_by_feature` and `observed_stop_times_by_feature` join them to features through the refs, so a route's and a stop's history continue across feed versions.

## Decisions

Made while planning V2 (2026-09-29 to 2026-10-01). Change them deliberately, and update this list.

| Topic | Decision |
|---|---|
| Basemap | **Protomaps** for the whole site. The old OpenMapTiles basemap is retired; the cycling overlay stays a separate source. |
| Hosting | The server and database on a **FullHost** VM in Toronto (4 vCPU, 8 GB, 100 GB). Object storage, including archives and backups, on **Cloudflare R2**, as are the tiles and published data. Cloudflare for DNS, the static site, CDN, WAF and rate limiting. Nothing here is sensitive, so files outside Canada are fine. ([deployment/README.md → Hosting](../deployment/README.md#hosting)) |
| Server stack | Node and TypeScript, **Hono**, plain SQL migrations and **Kysely**. Jobs in a `job_runs` table run by the leader rather than a queue library; revisit (graphile-worker, pg-boss) when jobs need concurrency or fan-out. |
| Frontend | **React** for the site's chrome; the transit engine and its WebGL layer stay framework-free and are mounted imperatively. Vehicles are drawn by our own WebGL2 custom layer through MapLibre's public API, not deck.gl (whose MapLibre integration depends on internals MapLibre v6 removed). |
| URL state | Path = mode (`/transit`, `/cycling`); `#map=z/lat/lng` is shared by every mode; the query holds the mode's own state. |
| Accounts | **GitHub sign-in.** Admin sessions are bearer tokens, not cookies (the site and API are on different origins, and an app can't rely on cookies). Anonymous reports, when they exist, are reviewed by an admin before they're posted anywhere. |
| Request budget | Stay within **1,000 TransLink requests a day** across all endpoints until TransLink approves more ([above](#upstream-request-budget)). Only production polls. |
| Retention | Raw real-time data (GTFS-RT, AIS, later GBFS) kept **60 days**. Observed stop times, per-route statistics and GTFS feeds kept **indefinitely**. |
| Statistics | "On time" is **1 minute early to 3 minutes late** at timepoints. |
| Frequency metric | The **90th-percentile gap over the upcoming hour** from the time viewed, per service and per shared corridor segment, computed at least every 30 minutes. Bands (one definition for cards and map, `packages/shared/src/frequency.ts`): Good ≤ 6 min, OK ≤ 12, Poor ≤ 20, Bad over 20. |
| Corrections | Observations and disruptions live in the database with review states and previews, with a file export. |
| Data snapshots | The server records all the time; developers pull snapshots of production data. Whether each dataset can be published depends on its source's license. |
| Attribution | Shown dynamically: the map credits exactly the datasets visible. |
| Analytics | Privacy-friendly: Cloudflare Web Analytics (cookieless). Self-hosted Umami later if we need custom events, carrying no identifiers. |
| Code license | **MIT** across the repo. |
| Data license | **ODbL** wherever we can, including our own content; no dual licensing ([DATA-LICENSES.md](../DATA-LICENSES.md)). |
| Fleet data | Our own: sightings, photos, reports and recorded tracks. The CPTDB wiki is used only to check ours, never copied. |
| Photos | Our own uploads, plus hand-picked Wikimedia Commons photos with license metadata. Never automatic. |
| Annotations | Live in the database, with an optional linked GitHub issue. |
| Mobile app | Low priority; mobile web must be good enough for testing and reporting. **Capacitor** is tentatively accepted (our core is MapLibre GL JS plus a custom WebGL layer, which React Native's native MapLibre bindings can't run), to be reviewed before starting. Meanwhile: token auth, bottom-sheet panels, touch targets ≥ 44 px, no dependence on hover. |
| Trip planning | Wanted after the mobile app. Evaluate reusing an existing system (the Transit app's API, OpenTripPlanner, MOTIS) before building anything. |
| Next city | Montreal, a long way off. |
| Feeds, operators and rail networks | **Operators are separate from feeds** (2026-10-15): settings come in layers (defaults, operator, feed, then route) under `config/`. **Rail networks own track** (2026-11-01, #250): infrastructure, operations, dispatch, disruptions and scenarios are a rail network's, observations and ferry berths a feed's. **No regions; feeds load by viewport** (2026-11-02, #250): regions (each a set of feeds the site showed one at a time) cut routes off at their edges and were thrown away at every boundary; one engine now loads each feed whose coverage is in view, and the site keeps only a few named views. Greater Victoria, Central Okanagan and the Fraser Valley (BC Transit's buses) keep the design multi-feed and multi-agency before a second big city. Zoomed out, every feed's routes come from one overview tileset (2026-10-20, #198). |
| Live data | **One poll per feed and per rail network** (2026-11-01, #250; one per region before, issue #177): `/feeds/<id>/live` and `/networks/<id>/live/dispatch`, each shared by every visitor and every view at the edge, with a section per source and pointers to immutable per-date files for anything large or slow-changing ([apps/server → Live endpoints](../apps/server/README.md#live-endpoints)). Per feed rather than per view, so a feed shown in several places is fetched and cached once. Polling, not server-sent events or WebSockets: an open connection per visitor would reach the one VM and lose the edge cache. |
| Feature IDs | **Prefixed random IDs** with a decorative name suffix in URLs, **refs** for source records, **no slugs** (2026-10-18, issue #193). The registry is in the database, GTFS refs hold over ranges of feed versions, containment is the registry's (the heuristics only propose it), and only production mints the IDs that are published. Plans hold no IDs: places files beside them do, so registry edits publish in minutes ([above](#feature-ids)). |
| Cycling layer | **Built by our TypeScript pipeline** (2026-10-27): osmium filters Geofabrik's extract in GitHub Actions, which publishes the result (about 20 MB for BC), so nothing else needs osmium, the 1.3 GB extract or osmium's 2.5 GB of memory; `packages/cycling-core` classifies ways and joins them into chains, and tippecanoe tiles them, as the transit lines are tiled. It replaced the Java Planetiler profile, so the classification is shared with the site and, later, the server, and a selected path is a whole chain ([packages/cycling-core](../packages/cycling-core/README.md)). |
| Bike routes | **In the database, with `cr` IDs** (2026-10-29, #229 phases 4–5): each cycling build's routes and their nesting are loaded into the database and served to route cards by the API (`GET /cycling/routes/<key>`), rather than published as one file, so the approach holds for all of Canada and for queries across routes. Route cards need the server; the map, paths and bike parking don't. Only bike routes get IDs (matched by their `osm-relation` ref, which holds for good); paths and bike parking keep OSM refs. In the tiles, each route is one feature up to z12, overzoomed beyond, so the selected route is highlighted whole. |
| Transit lines | **Vector tiles, built with the data** (2026-10-20, #198): every line a plan draws is in tiles of its own, named by their content, and the engine styles them (feature state, global state, filters) rather than drawing GeoJSON; one overview tileset shows every feed zoomed out. No interim GeoJSON overview ([packages/transit-core → Plan tiles](../packages/transit-core/DESIGN.md#plan-tiles)). |
| Environments | Production and local development. A staging environment can be added cheaply later: configuration in env files, hostnames and buckets as config, unattended migrations, a Compose project per environment. Staging would never poll TransLink. |

## Risks

| Risk | Mitigation |
|---|---|
| The TransLink request limit makes live buses less accurate (fixes 1–5 minutes apart) | A budget weighted to peaks, measured with `eval-rt --subsample`; honest provenance; asking TransLink for more. |
| Raw data is deleted after 60 days, so a statistic we didn't compute is lost | Observed stop times are kept indefinitely; the statistics job catches up after downtime, and `/healthz` fails when it hasn't succeeded for 36 hours. |
| TransLink's license is revocable on 10 days' notice | Attribution, no trade-mark use, sharing findings. The static-first design degrades to schedules. |
| One VM is a single point of failure | Static first, freshness monitoring, backups with another provider, tested restores. |
| The OSM track graph has gaps or errors | Overrides survive re-imports; the validator and diagram checklist; fixes go upstream to OSM. |
| Run inference or the dispatcher is implausible (fleet counts, turnbacks, delays, deadlocks) | Everything is config; `validate:plan` reports fleet peaks, conflicts, delays and broken deadlocks; route locking; corrections; field checks against GPS rides; the open questions. |
| GTFS changes (new signups, route IDs, platform stops) | Routes selected by name; per-feed builds; the validator fails loudly on unmapped platforms. |
| Untrusted input changes what everyone sees | Only confirmed corrections feed the dispatcher; visitor requests never trigger a dispatch. |
| Browser performance (all buses, phones) | Lazy per-feed and per-day files, the custom WebGL layer, simplified geometry at low zoom; later viewport-limited prediction and instanced markers. |
| A long feature list for a small team | Strict priorities, each milestone ships, continuous quality work instead of rewrites. |
| FullHost is less widely used than the big clouds | Only the VM is there; everything is portable Docker and S3, with backups at another provider. |
