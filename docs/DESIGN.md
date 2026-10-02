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
| Metro Vancouver: what we know about operations, and what we don't | [regions/metro-vancouver/README.md](../regions/metro-vancouver/README.md), [OPEN-QUESTIONS.md](../regions/metro-vancouver/OPEN-QUESTIONS.md) |
| Hosting, deployment and operations | [deployment/README.md](../deployment/README.md) |
| Data licenses and sources | [DATA-LICENSES.md](../DATA-LICENSES.md) |

Planned work is tracked in [GitHub issues](https://github.com/transitopia/transitopia/issues), grouped by milestone.

## Goals and scope

Transitopia is one site with **transit** and **cycling** modes, backed by a long-running server in Canada and a PostgreSQL database for everything we collect and curate.

- **Cycling**: the cycling and micromobility map of British Columbia, from our own Planetiler profile (`map-layers/`).
- **Transit** (Metro Vancouver): Our goal is to show every transit mode in real-time on a single map. Currently we show express buses and SeaBus using accurate real-time data, and we do our best to model SkyTrain and West Coast Express based on their schedule. The web app features a time slider covering past, live and projected future service. Corrections, disruptions, scenarios and a signalling-aware dispatcher refine the schedule where possible.
- **Walking** is planned for the future.

Some upcoming priorities, in order: details panels, the frequency map, submissions and annotations, micromobility, all buses, a mobile app, and trip planning. Data quality and site performance improve continuously alongside all of these. The long-term goal is SkyTrain-level detail in other cities, one city at a time: Vancouver first, Montreal next.

Desktop-first, but the map and time controls must work on phones, with minimal chrome.

## Principles

1. **Positions are a pure function of (plan, overlays, t).** No frame-stepped state in the client. This is what makes seeking, rewinding and fast-forwarding work, and it applies to every mode we animate.
2. **Provenance everywhere.** Vehicles carry `observed | interpolated | estimated` and a source. Curated facts carry a source and a date. Never present an estimate as fact.
3. **Upstream APIs are polled centrally,** within each provider's limits and on an explicit request budget ([below](#upstream-request-budget)). Client requests never trigger calls to TransLink, aisstream.io or OSM, and neither do development machines.
4. **Shared state is computed centrally.** The dispatcher and disruption parsing run on the server or at build time, and every visitor sees the same versioned result.
5. **Secrets never reach the browser or the app bundle.**
6. **Infrastructure is data.** OSM first, fixed upstream where possible. Our own fixes are reviewable data (`regions/*/infrastructure/overrides.json`).
7. **Nothing untrusted reaches the public map or the dispatcher without review.** Drafts can be previewed, but only confirmed inputs are published ([below](#corrections-and-previews)).
8. **Static first, dynamic where needed.** Anything that can be an immutable file behind a CDN is one. The server handles live data, writes and moderation. If the server is down, the site degrades to schedule estimates instead of breaking.
9. **Licensing is tracked per dataset** ([DATA-LICENSES.md](../DATA-LICENSES.md)). Every dataset records its source and license, and publishing respects them.
10. **Every assumption is config.** Operating assumptions live in `regions/<region>/config/` with a source or "guess", and a cross-reference to the region's open questions. No magic numbers in code.

## Architecture

```
                         ┌─────────────────── Cloudflare (DNS, CDN, WAF, R2) ──────────────────┐
 Browser ──────────────▶ │ www.transitopia.org        static SPA (Pages, from the prod branch) │
                         │ map-tiles.transitopia.org  basemap and cycling tiles (worker on R2) │
                         │ data.transitopia.org       transit data build output (R2)           │
                         │ api.transitopia.org ─┐     proxied; /rt/live edge-cached 10 s       │
                         └──────────────────────┼──────────────────────────────────────────────┘
                                                ▼
                         ┌───────────── FullHost VM, Toronto (Docker Compose) ──────────────┐
                         │ server (Node/TS, Hono)                                           │
                         │  ├ API: /rt/* (live, history, changes, dispatch, AIS), /healthz, │
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
packages/db/               PostgreSQL: SQL migrations, Kysely types, partitions, jobs
packages/shared/           shared by web and server: the dataset registry
pipelines/                 build-time pipelines and validators; lib/paths.ts knows where data lives
regions/metro-vancouver/   committed, curated inputs: region.json, config/, infrastructure/, scenarios/, observations/, disruptions/
map-layers/                Planetiler (Java) profile for the cycling layer
infra/                     production Compose stack, server image, Caddy, backups, firewall; the local database
deployment/                setup and operations notes, the tile worker
var/                       gitignored: downloads, recordings, build output (var/public is the transit data's web root)
```

## Where data lives

| Data | Where | Kept |
|---|---|---|
| Scenarios, infrastructure overrides, operations config | Git (`regions/`), checked by the validators | |
| Observations and disruptions | Database, with review states and an export to the file format in `regions/*/observations/` and `regions/*/disruptions/` ([below](#corrections-and-previews)) | indefinitely |
| Raw real-time data: GTFS-RT positions and AIS fixes | Database (partitioned by day) and hourly NDJSON.gz files, copied to the archive bucket | **60 days** |
| Observed stop times per trip and stop | Database (partitioned by month) | indefinitely |
| Per-route daily statistics | Database (`route_stats_daily`) | indefinitely |
| Trip changes (cancellations, skipped stops), alerts with first and last seen, dispatch versions | Database (and files) | indefinitely |
| GTFS static feeds | Archive bucket (the original zips) and `gtfs_feeds` | indefinitely |
| Request ledger (`upstream_requests`) | Database | |
| Published transit data (plans, movements, patches) | `transitopia-data` on R2, behind data.transitopia.org | |

Tables and migrations are described in [packages/db/README.md](../packages/db/README.md).

## Retention and statistics

Raw real-time data is deleted after 60 days (`regions/metro-vancouver/config/recording.json`). Any statistic we haven't computed by then can never be computed for that period, so:

- **Observed stop times are the atom.** From each vehicle's fixes we derive, per trip and stop, the observed (interpolated) arrival and departure, its precision (the time between the fixes it came from), and the scheduled time. Nearly every statistic can be recomputed from them, including ones we haven't thought of yet. They're kept indefinitely.
- **A daily job** computes statistics for each finished service date while the raw data is still there, and catches up after downtime: per route, direction, day and time band, trips scheduled, observed and cancelled, skipped stops, on-time performance at timepoints (on time = **1 minute early to 3 minutes late**), delay percentiles, delivered versus scheduled headways, and bunching. `npm run stats -- <YYYYMMDD>` recomputes a date.
- **Coverage is the denominator.** Every statistic records how much of the period the recorder covered. "Cancelled" and "on time" only mean something where we were recording; gaps are reported as gaps, never as zeros.
- **Statistics are versioned.** Each row records the version of the code that produced it, so a changed definition can be recomputed from the atom.
- **Every route is recorded,** not just the ones drawn. Each response already covers every TransLink vehicle, so this costs no extra requests, only storage. Vehicles on routes we don't draw get an untracked route key (`gtfs:<route_id>`), and every reader keeps only tracked ones (`trackedOnly`).

Kept in Postgres, observed stop times grow by about 78 GB a year ([deployment/README.md → Sizing](../deployment/README.md#sizing)), so older months need to move to monthly files in object storage within about a year of recording.

## Upstream request budget

TransLink's terms give an API key "a maximum of 1,000 requests per day". Until TransLink approves more, the leader stays under that across `gtfsposition`, `gtfsrealtime` (trip updates) and `gtfsalerts`, polling more often at peak and less off-peak. The schedule is config (`regions/metro-vancouver/config/rt.json` → `poll`):

| Weekday band | Positions | Trip updates | Alerts |
|---|---|---|---|
| Peak: 06:30–09:30, 15:00–18:30 | every 60 s | every 4 min | every 20 min |
| Day and evening: 05:00–06:30, 09:30–15:00, 18:30–23:00 | every 150 s | every 10 min | every 30 min |
| Night: 23:00–05:00 | every 5 min | every 30 min | hourly |

Weekends have their own, flatter schedule with a midday peak. Together they stay at about 970 requests in any 24 hours.

- **Hard cap**: a ledger (`upstream_requests`, or `var/rt-history/requests.json` without a database) counts every attempt, including failures. The poller stops at the cap, error backoff is long because it spends budget, and a restarted leader resumes each feed's schedule instead of polling at once.
- **One poller**: only the leader polls (a Postgres advisory lock), so there's one counter. Other instances forward `/rt/*` to it.
- **Only production polls.** The key's budget is shared, so a server polls only with `RT_POLL=1`. Local development forwards to production (`RT_FORWARD_TO=https://api.transitopia.org`), points the site straight at it, or uses snapshots of production data ([deployment/README.md → Snapshots](../deployment/README.md#snapshots-for-development)).
- **Effect on quality**: fixes come 1–5 minutes apart instead of ~30 s. Thresholds that depend on the cadence (stale data, coverage gaps, "observed" windows, prediction limits) follow the interval in use (`packages/transit-core/src/rt/budget.ts`). `npx tsx pipelines/eval-rt.ts --subsample schedule` replays recorded history as if polled on the schedule.

Other providers get budgets under their own terms. aisstream.io is one WebSocket held by the leader.

## Corrections and previews

Observations (sightings of a train or vessel at a stop at a time, consists, cancellations) and disruptions (single-track sections, reduced headways for a period) refine the schedule. The engine side is in [packages/transit-core/DESIGN.md → Corrections](../packages/transit-core/DESIGN.md#corrections) and [→ Disruptions and alerts](../packages/transit-core/DESIGN.md#disruptions-and-alerts).

- In production they live in the database, each with a review state: `draft → previewing → confirmed | discarded`. The server drafts disruptions from TransLink alerts; admins edit them at `/admin`.
- **Preview**: an admin dispatches the dates a draft touches (within a week of today) with the draft added. The result is a **preview version**: an immutable dispatch patch like any other, but not advertised in `/rt/live`. `/admin` links to `/transit?preview=<YYYYMMDD>:<version>`, and the time bar says it's showing unconfirmed corrections. Preview versions hold nothing private, so anyone with the link can see one.
- **Confirm** publishes the input, and the next regular dispatch includes it. A disruption can't be confirmed without saying which track stays open. Editing a confirmed input sends it back to draft.
- The files under `regions/metro-vancouver/{observations,disruptions}/` are imported into a new database, and are what local runs without a database use. `npm run corrections -- export|import|pull` moves corrections between the two.
- Precedence, shown as provenance: manual observation > live sensor (GTFS-RT, AIS) > confirmed disruption or alert > schedule.

## Attribution

Each dataset has an entry in the registry (`packages/shared/src/datasets.ts`): id, short credit, full legend text, link and license. Every map source, layer and engine component declares which datasets it draws (`useDatasets([...])` in the site), and the site's attribution control (replacing MapLibre's default) credits exactly what's visible: the layers turned on, plus whether the engine is drawing any vehicle from that dataset. On phones it collapses to a short line with an ⓘ button.

TransLink's required legend ("Some of the data used in this product or service is provided by permission of TransLink. …") appears in full whenever TransLink data is visible: in the expanded credits and in the vehicle card.

## Regions

A **region** (`regions/<id>/region.json`) holds the bbox, time zone, the first view, and time zone checks. Everything about a region is data under `regions/<id>/`:

```
regions/metro-vancouver/
  region.json                  bbox, time zone, initial view, tzdata checks
  config/                      kinematics, dwell, turnbacks, dispatch, rt (poll schedule, prediction), seabus, routes, recording
  infrastructure/              tracks.generated.geojson (from OSM), future.generated.geojson, overrides.json, seabus.json, diagram-checklist.json
  scenarios/                   scenario specs and custom geometry
  observations/, disruptions/  corrections in the file format
  README.md, OPEN-QUESTIONS.md what we know about operations, and what we don't
```

Regions have tiers of detail: (1) track-level rail, the goal everywhere and Vancouver today; (2) shape-level schedules from any GTFS, the starting point for a new city; (3) live buses from any GTFS-RT. Track-level work for a new city reuses the whole OSM import → overrides → platform mapping → run inference → dispatcher pipeline; what's new per city is curation (overrides, operations config, open questions). Agency quirks (TransLink's alert phrasing, GTFS oddities) belong behind per-agency adapters, and generic GTFS handling stays generic. Other signalling systems (fixed block) would need a dispatcher extension.

The basemap is a British Columbia extract of Protomaps' daily build for now. It grows to Canada, then Canada and the US, then the planet as regions are added; only the extract's area changes. Outside the basemap the map has no tiles, and outside a configured region `/transit` says transit data isn't available there yet.

Time zones come from the runtime's tzdata, never hard-coded. BC moved to permanent UTC−7 in 2026 (tzdata 2026b); the server refuses to start on older data (`timezoneChecks` in `region.json`).

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
