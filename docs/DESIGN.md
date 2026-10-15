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
| Metro Vancouver: what we know about operations, and what we don't | [config/regions/metro-vancouver/README.md](../regions/metro-vancouver/README.md), [OPEN-QUESTIONS.md](../regions/metro-vancouver/OPEN-QUESTIONS.md) |
| Greater Victoria and Central Okanagan (BC Transit) | [config/regions/greater-victoria/README.md](../regions/greater-victoria/README.md), [config/regions/central-okanagan/README.md](../regions/central-okanagan/README.md) |
| Hosting, deployment and operations | [deployment/README.md](../deployment/README.md) |
| Data licenses and sources | [DATA-LICENSES.md](../DATA-LICENSES.md) |

Planned work is tracked in [GitHub issues](https://github.com/transitopia/transitopia/issues), grouped by milestone.

## Goals and scope

Transitopia is one site with **transit** and **cycling** modes, backed by a long-running server in Canada and a PostgreSQL database for everything we collect and curate.

- **Cycling**: the cycling and micromobility map of British Columbia, from our own Planetiler profile (`map-layers/`).
- **Transit** (Metro Vancouver, with a few BC Transit routes in Greater Victoria and Kelowna to keep the design [multi-region](#regions-and-feeds)): Our goal is to show every transit mode in real-time on a single map. Currently we show express buses and SeaBus using accurate real-time data, and we do our best to model SkyTrain and West Coast Express based on their schedule. The web app features a time slider covering past, live and projected future service. Corrections, disruptions, scenarios and a signalling-aware dispatcher refine the schedule where possible.
- **Walking** is planned for the future.

Some upcoming priorities, in order: details panels, the frequency map, submissions and annotations, micromobility, all buses, a mobile app, and trip planning. Data quality and site performance improve continuously alongside all of these. The long-term goal is SkyTrain-level detail in other cities, one city at a time: Vancouver first, Montreal next.

Desktop-first, but the map and time controls must work on phones, with minimal chrome.

## Principles

1. **Positions are a pure function of (plan, overlays, t).** No frame-stepped state in the client. This is what makes seeking, rewinding and fast-forwarding work, and it applies to every mode we animate.
2. **Provenance everywhere.** Vehicles carry `observed | interpolated | estimated` and a source. Curated facts carry a source and a date. Never present an estimate as fact.
3. **Upstream APIs are polled centrally,** within each provider's limits and on an explicit request budget ([below](#upstream-request-budget)). Client requests never trigger calls to TransLink, aisstream.io or OSM, and neither do development machines.
4. **Shared state is computed centrally.** The dispatcher and disruption parsing run on the server or at build time, and every visitor sees the same versioned result.
5. **Secrets never reach the browser or the app bundle.**
6. **Infrastructure is data.** OSM first, fixed upstream where possible. Our own fixes are reviewable data (`config/regions/*/infrastructure/overrides.json`).
7. **Nothing untrusted reaches the public map or the dispatcher without review.** Drafts can be previewed, but only confirmed inputs are published ([below](#corrections-and-previews)).
8. **Static first, dynamic where needed.** Anything that can be an immutable file behind a CDN is one. The server handles live data, writes and moderation. If the server is down, the site degrades to schedule estimates instead of breaking.
9. **Licensing is tracked per dataset** ([DATA-LICENSES.md](../DATA-LICENSES.md)). Every dataset records its source and license, and publishing respects them.
10. **Every assumption is config.** Operating assumptions live in `config/regions/<region>/` with a source or "guess", and a cross-reference to the region's open questions. No magic numbers in code. Every config file has a schema (`packages/transit-core/src/config.ts`), checked wherever it's loaded, so a mistyped setting fails instead of reading as undefined.

## Architecture

```
                         ┌─────────────────── Cloudflare (DNS, CDN, WAF, R2) ──────────────────┐
 Browser ──────────────▶ │ www.transitopia.org        static SPA (Pages, from the prod branch) │
                         │ map-tiles.transitopia.org  basemap and cycling tiles (worker on R2) │
                         │ data.transitopia.org       transit data build output (R2)           │
                         │ api.transitopia.org ─┐     proxied; live poll edge-cached ≤ 10 s    │
                         └──────────────────────┼──────────────────────────────────────────────┘
                                                ▼
                         ┌───────────── FullHost VM, Toronto (Docker Compose) ──────────────┐
                         │ server (Node/TS, Hono)                                           │
                         │  ├ API: /regions/<id>/live/transit, per-date files (AIS,         │
                         │  │      changes), /rt/* (history, dispatch), /healthz,           │
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
packages/data/             Node-side data access for pipelines and the server: where data lives (paths.ts), GTFS zips, disruption files, dispatch contexts
packages/db/               PostgreSQL: SQL migrations, Kysely types, partitions, jobs
packages/shared/           shared by web and server: the dataset registry
pipelines/                 build-time pipelines and validators
config/                    committed, curated inputs: defaults/, operators/, feeds/, regions/ (Regions and feeds, below)
map-layers/                Planetiler (Java) profile for the cycling layer
infra/                     production Compose stack, server image, Caddy, backups, firewall; the local database
deployment/                setup and operations notes, the tile worker
var/                       gitignored: downloads, recordings, build output (var/public is the transit data's web root)
```

## Where data lives

| Data | Where | Kept |
|---|---|---|
| Scenarios, infrastructure overrides, operations config | Git (`regions/`), checked by the validators | |
| Observations and disruptions | Database, with review states and an export to the file format in `config/regions/*/observations/` and `config/regions/*/disruptions/` ([below](#corrections-and-previews)) | indefinitely |
| Raw real-time data: GTFS-RT positions and AIS fixes | Database (partitioned by day) and hourly NDJSON.gz files, copied to the archive bucket | **60 days** |
| Observed stop times per trip and stop | Database (partitioned by month) | indefinitely |
| Per-route daily statistics | Database (`route_stats_daily`) | indefinitely |
| Trip changes (cancellations, skipped stops), alerts with first and last seen, dispatch versions | Database (and files) | indefinitely |
| GTFS static feeds | Archive bucket (the original zips) and `gtfs_feeds` | indefinitely |
| Request ledger (`upstream_requests`) | Database | |
| Published transit data (plans, movements, patches) | `transitopia-data` on R2, behind data.transitopia.org | |

Tables and migrations are described in [packages/db/README.md](../packages/db/README.md).

## Retention and statistics

Raw real-time data is deleted after 60 days (`config/regions/metro-vancouver/recording.json`). Any statistic we haven't computed by then can never be computed for that period, so:

- **Observed stop times are the atom.** From each vehicle's fixes we derive, per trip and stop, the observed (interpolated) arrival and departure, its precision (the time between the fixes it came from), and the scheduled time. Nearly every statistic can be recomputed from them, including ones we haven't thought of yet. They're kept indefinitely.
- **A daily job** computes statistics for each finished service date while the raw data is still there, and catches up after downtime: per route, direction, day and time band, trips scheduled, observed and cancelled, skipped stops, on-time performance at timepoints (on time = **1 minute early to 3 minutes late**), delay percentiles, delivered versus scheduled headways, and bunching. `npm run stats -- <YYYYMMDD>` recomputes a date.
- **Coverage is the denominator.** Every statistic records how much of the period the recorder covered. "Cancelled" and "on time" only mean something where we were recording; gaps are reported as gaps, never as zeros.
- **Statistics are versioned.** Each row records the version of the code that produced it, so a changed definition can be recomputed from the atom.
- **Every route is recorded,** not just the ones drawn. Each response already covers every TransLink vehicle, so this costs no extra requests, only storage. Vehicles on routes we don't draw get an untracked route key (`gtfs:<route_id>`), and every reader keeps only tracked ones (`trackedOnly`).

Kept in Postgres, observed stop times grow by about 78 GB a year ([deployment/README.md → Sizing](../deployment/README.md#sizing)), so older months need to move to monthly files in object storage within about a year of recording.

## Upstream request budget

Every feed is polled within a budget of its own (`config/feeds/<feed>/feed.json` → `realtime.poll`: a daily cap and a time-of-day schedule), whatever its provider allows. TransLink's terms give an API key "a maximum of 1,000 requests per day". Until TransLink approves more, the leader stays under that across `gtfsposition`, `gtfsrealtime` (trip updates) and `gtfsalerts`, polling more often at peak and less off-peak:

| Weekday band | Positions | Trip updates | Alerts |
|---|---|---|---|
| Peak: 06:30–09:30, 15:00–18:30 | every 60 s | every 4 min | every 20 min |
| Day and evening: 05:00–06:30, 09:30–15:00, 18:30–23:00 | every 150 s | every 10 min | every 30 min |
| Night: 23:00–05:00 | every 5 min | every 30 min | hourly |

Weekends have their own, flatter schedule with a midday peak. Together they stay at about 970 requests in any 24 hours. BC Transit's feeds need no key and state no limit; each is polled every 30 s for positions, 2 minutes for trip updates and 5 for alerts while buses run (less overnight), about 3,500 requests a day, with a cap of 4,000.

- **Hard cap**: a ledger per feed (`upstream_requests`, or `var/rt-history/<feed>/requests.json` without a database) counts every attempt, including failures. The poller stops at the cap, error backoff is long because it spends budget, and a restarted leader resumes each feed's schedule instead of polling at once.
- **One poller**: only the leader polls (a Postgres advisory lock), so there's one counter. Other instances forward `/rt/*` to it.
- **Only production polls.** The key's budget is shared, so a server polls only with `RT_POLL=1`, keyless feeds included. Local development forwards to production (`RT_FORWARD_TO=https://api.transitopia.org`), points the site straight at it, or uses snapshots of production data ([deployment/README.md → Snapshots](../deployment/README.md#snapshots-for-development)).
- **Effect on quality**: fixes come 1–5 minutes apart instead of ~30 s. Thresholds that depend on the cadence (stale data, coverage gaps, "observed" windows, prediction limits) follow the interval in use (`packages/transit-core/src/rt/budget.ts`). `npx tsx pipelines/eval-rt.ts --subsample schedule` replays recorded history as if polled on the schedule.

Other providers get budgets under their own terms. aisstream.io allows 3 connections per account: production's leader holds one WebSocket, which leaves room for `pipelines/probe-ais.ts` and the occasional local test.

## Corrections and previews

Observations (sightings of a train or vessel at a stop at a time, consists, cancellations) and disruptions (single-track sections, reduced headways for a period) refine the schedule. The engine side is in [packages/transit-core/DESIGN.md → Corrections](../packages/transit-core/DESIGN.md#corrections) and [→ Disruptions and alerts](../packages/transit-core/DESIGN.md#disruptions-and-alerts).

- In production they live in the database, each with a review state: `draft → previewing → confirmed | discarded`. The server drafts disruptions from TransLink alerts; admins edit them at `/admin`.
- **Preview**: an admin dispatches the dates a draft touches (within a week of today) with the draft added. The result is a **preview version**: an immutable dispatch patch like any other, but not advertised by the live endpoint. `/admin` links to `/transit?preview=<YYYYMMDD>:<version>`, and the time bar says it's showing unconfirmed corrections. Preview versions hold nothing private, so anyone with the link can see one.
- **Confirm** publishes the input, and the next regular dispatch includes it. A disruption can't be confirmed without saying which track stays open. Editing a confirmed input sends it back to draft.
- The files under `config/regions/metro-vancouver/{observations,disruptions}/` are imported into a new database, and are what local runs without a database use. `npm run corrections -- export|import|pull` moves corrections between the two.
- Precedence, shown as provenance: manual observation > live sensor (GTFS-RT, AIS) > confirmed disruption or alert > schedule.

## Attribution

Each dataset has an entry in the registry (`packages/shared/src/datasets.ts`): id, short credit, full legend text, link and license. Every map source, layer and engine component declares which datasets it draws (`useDatasets([...])` in the site), and the site's attribution control (replacing MapLibre's default) credits exactly what's visible: the layers turned on, plus whether the engine is drawing any vehicle from that dataset. On phones it collapses to a short line with an ⓘ button.

Transit data is credited per route, never by naming a provider in UI code: each route in a plan names its feed's dataset (`PlanRoute.dataset`, from `dataset` in its `feed.json`; plans built before it fall back to the feed's, passed to the engine), and a schedule dataset names its provider's real-time companion (`realtime`). The engine's snapshots say which datasets lie behind what's drawn and behind each card (a vehicle, a route, a place's departures, adding the real-time dataset where real positions or predictions are shown), so with several providers each card credits only its own.

Required legends, such as TransLink's ("Some of the data used in this product or service is provided by permission of TransLink. …"), appear in full whenever that data is visible: in the expanded credits and in the footer of each card showing it.

## Regions and feeds

Everything committed and curated is under `config/` (one package, `@transitopia/config`), with schemas in `packages/transit-core/src/config.ts`, checked by a test over every committed file:

```
config/
  defaults/        kinematics.json, rt.json: vehicles and real-time use, for every region and operator
  operators/<id>/  operator.json: who runs the vehicles (TransLink, BC Transit), and its overrides of the defaults
  feeds/<id>/      feed.json: one agency's published data (GTFS, GTFS-RT, request budget, vessels' AIS),
                   naming its operator; routes.json: which routes are drawn, by name
  regions/<id>/    region.json: a place on the map (bbox, time zone, first view, the feeds it shows);
                   its settings (rt.json, and for Metro Vancouver operations, dispatch, seabus, recording);
                   infrastructure/, scenarios/, observations/, disruptions/; README, OPEN-QUESTIONS
```

| Region | Feeds (operator) | Drawn |
|---|---|---|
| `metro-vancouver` | `translink` (TransLink) | SkyTrain, SeaBus, West Coast Express, 99, R1–R6 |
| `greater-victoria` | `bc-transit-victoria` (BC Transit) | 95 Blink RapidBus, 15, 70 |
| `central-okanagan` | `bc-transit-kelowna` (BC Transit) | 97 Okanagan RapidBus |

Feeds are separate from regions because neither contains the other: a ferry between two regions (Hullo, Vancouver–Victoria) is one feed in both, and a region can show several agencies. Operators are separate from feeds because one operator publishes many: BC Transit has a feed per transit system, in several regions.

**Settings come in layers** (`resolveKinematics`, `resolveRt`): the defaults, then the feed's operator's overrides (a mode's vehicle settings; bus prediction and carried delays, which depend on its buses and data), then the feed's own (`feed.json` → `kinematics`, `rt`: one system of an operator with different buses or data), then for vehicles its routes' (`routes.json` → `kinematics`, e.g. a SkyTrain line's train length), and for real time the region's (`rt.json`). A region's settings are only about the place (how often its map polls, live dispatch, the server's port), never about vehicles or data, since a region can show several feeds. Each layer is partial; the result is checked whole, so a misspelled setting in any layer still fails. Vehicles' minimum drawn size is the defaults' alone, so they look alike everywhere. How often a feed is polled, and the thresholds that follow from it, are the feed's own (`feed.json` → `realtime`).

Everything that comes from a feed is keyed by the feed, and happens once whichever regions show it:

- **Built** per feed: `var/raw/gtfs/<feed>/<version>/`, published at `data/feeds/<feed>/manifest.json` and `data/feeds/<feed>/<version>/` (plan, movements, platforms, real-time profile). A GTFS `feed_version` becomes a directory name with anything but letters, digits, `.`, `_` and `-` replaced (`versionDir`).
- **Polled and recorded** per feed: one poller each on the server's leader, within the feed's own budget (`feed.json` → `realtime.poll`), and one AIS stream for a feed whose vessels report AIS (`feed.json` → `ais`: TransLink's SeaBus); recordings in `var/rt-history/<feed>/` and `var/ais-history/<feed>/`; database rows keyed by `feed_id`.
- What's the **region's** is published under `data/regions/<id>/`: the track network, observations, dispatch patches and scenarios.

**Track-level rail** runs on **rail networks** (`railNetworks()` in `packages/data/src/paths.ts`): a feed with track-level routes (kind `skytrain`) and the region showing it whose track network it runs on (`infrastructure/tracks.generated.geojson`). The rail pipelines loop over them. The server's live dispatcher, its corrections and `/admin` support one rail network so far (`railNetwork()`, which fails at startup if there are more): a second rail city needs those per region.

The live endpoint is per region (`/regions/<id>/live/transit`), with sections per feed (`<feed>/vehicles`, `<feed>/changes`, `<feed>/ais`) and the region's own (`dispatch`).

Agencies shape their ids differently, so a feed also says how riders see them (`feed.json` → `display`: a regex each for trip ids and versions, whose first group is the short form; `packages/transit-core/src/plan/display.ts`). A vehicle card shows "Trip 08:05 from Langford Exchange · 11898518" (where riders can first board it, and the short id) and "Source: BC Transit timetable (202610140)"; links, observations and recordings keep the full GTFS ids.

**On the site**, `/transit` shows one region at a time: the one whose bbox covers most of the view (`apps/web/src/TransitMap/regions.ts`, which finds every region, feed and operator in `config/`, so adding a region is data only). Panning into another region recreates the engine for it, keeping the time; outside every region a box offers each. The engine draws one feed per region for now (`RegionConfig.feed`): a region with several feeds needs the engine to merge their plans, layers and live sections, which is the next step when one exists.

Regions have tiers of detail: (1) track-level rail, the goal everywhere and Vancouver today; (2) shape-level schedules from any GTFS, the starting point for a new city; (3) live buses from any GTFS-RT, as in Victoria and Kelowna. Track-level work for a new city reuses the whole OSM import (`--region`) → overrides → platform mapping → run inference → dispatcher pipeline; what's new per city is curation (overrides, operations config, open questions). Agency quirks (TransLink's alert phrasing, GTFS oddities) belong behind per-agency adapters, and generic GTFS handling stays generic: BC Transit's feeds needed only generic changes (bay names without `@`, `calendar_dates.txt` without `calendar.txt`, a `feed_version` with slashes). Other signalling systems (fixed block) would need a dispatcher extension.

Service dates are `"YYYYMMDD"` strings typed `ServiceDate` (`packages/transit-core/src/time.ts`), a branded type so they can't be mixed up with ISO dates or other strings: they come from `serviceDate()`/`isServiceDate()` where they enter (GTFS, URLs, requests, the command line), `isoToServiceDate()` for observations' ISO dates, and the time helpers.

The basemap is a British Columbia extract of Protomaps' daily build for now. It grows to Canada, then Canada and the US, then the planet as regions are added; only the extract's area changes. Outside the basemap the map has no tiles.

Time zones come from the runtime's tzdata, never hard-coded. BC moved to permanent UTC−7 in 2026 (tzdata 2026b); the server refuses to start on older data (`timezoneChecks` in each `region.json`). Every region and feed so far is in `America/Vancouver`, which `packages/transit-core/src/time.ts` assumes; `build-schedule` refuses a feed in another time zone until regions carry their own.

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
| Frequency metric | The **90th-percentile gap over the upcoming hour** from the time viewed, per service and per shared corridor segment, computed at least every 30 minutes. Thresholds: great < 3 min, good < 6, not so great < 12, bad < 16, poor ≥ 16. |
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
| Next region | Montreal, a long way off. |
| Regions and feeds | **Feeds are separate from regions** (2026-10-14), and **operators from feeds** (2026-10-15): a region lists the feeds it shows, and a feed (fetched, built, polled, recorded) can be in several; settings come in layers (defaults, operator, feed, then route or region) under `config/`; a region's are only about the place. Greater Victoria and Central Okanagan (a few BC Transit routes) keep the design multi-region and multi-agency before a second big city. The site shows one region at a time, the one in view ([above](#regions-and-feeds)). |
| Live data | **One poll per map**: `/regions/<id>/live/transit` for transit (later `/regions/<id>/live/cycling` for GBFS), shared by every visitor at the edge, with a section per source (agency or feed) and pointers to immutable per-date files for anything large or slow-changing ([apps/server → Live endpoint](../apps/server/README.md#live-endpoint), issue #177). Polling, not server-sent events or WebSockets: an open connection per visitor would reach the one VM and lose the edge cache. |
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
