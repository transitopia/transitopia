# Transitopia server

The server behind `api.transitopia.org` (Node, TypeScript, [Hono](https://hono.dev)). It serves real-time data to the site, and on the leader it polls TransLink within the request budget, streams SeaBus AIS, records everything, re-dispatches SkyTrain when corrections change, and runs the scheduled jobs. How it fits with the rest: [docs/DESIGN.md](../../docs/DESIGN.md). Hosting and operations: [deployment/README.md](../../deployment/README.md#the-server-apitransitopiaorg).

```sh
# run using schedules only: no polling of real-time APIs
npm run server
# run with production's live data
RT_FORWARD_TO=https://api.transitopia.org npm run server
# Start using local PostgreSQL (infra/compose.dev.yml):
npm run db:up
DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/transitopia npm run server
```

Run the site against it with `VITE_TRANSIT_API=http://localhost:8787/ npm run dev`. Without `DATABASE_URL` the server records to files only (`var/rt-history/`, `var/ais-history/`, `var/dispatch-history/`), uses a lock file for leadership, and reads corrections from `regions/metro-vancouver/{observations,disruptions}/`.

## API

```
GET /rt/live                        latest snapshot (JSON, CORS, Cache-Control max-age=10) + live dispatch versions
GET /rt/history?date=YYYY-MM-DD&hour=HH   recorded snapshots for one local hour (NDJSON, drawn routes only)
GET /rt/coverage?from=ms&to=ms      recorder coverage intervals
GET /rt/status                      poller health and budget (no secrets)
GET /rt/alerts                      current TransLink alerts for our rail lines, and whether each was drafted
GET /rt/changes?date=YYYYMMDD       bus trips cancelled or skipping stops, and bus route alerts, for a service date
GET /rt/dispatch                    live dispatch: current patch version per service date
GET /rt/dispatch/<date>/<v>.json    a patch version (immutable)
GET /rt/ais/fixes?date=YYYYMMDD[&after=cursor]   SeaBus AIS fixes for a service date
GET /healthz                        data freshness: 503 when polls, AIS, the database or a daily job are stale
GET /auth/github/login[?page=trackside], /auth/github/callback, /auth/me; POST /auth/logout     admin sign-in
/admin/api/*                        the review queue behind /admin, and trackside camera uploads (admins only)
```

`/rt/*` is public, with CORS for everyone, and cached at Cloudflare's edge (`/rt/live` for 10 s), so server load doesn't grow with visitors. `/admin/api` and `/auth` allow only `ALLOWED_ORIGINS`.

## Leader

Exactly one process polls, records, dispatches and runs jobs: the leader (`src/leader.ts`), elected by a Postgres advisory lock (a lock file without a database). Other instances forward `/rt/*` to it (`ADVERTISE_URL`) and take over when it goes away. If the leader loses the lock's database connection, it exits so it can restart cleanly.

## Real-time service

`src/rt/service.ts`, `upstream.ts`, `recorder.ts`, `changes.ts`, `alerts.ts`, `ais.ts`.

- **One upstream poller**: a loop per feed fetches `gtfsposition`, `gtfsrealtime` (delays, cancellations, skipped stops) and `gtfsalerts` on the time-of-day schedule in `regions/metro-vancouver/config/rt.json` → `poll`, regardless of how many clients are connected. Client requests never trigger upstream fetches; they read the latest cached snapshot. The schedule and the hard cap are described in [docs/DESIGN.md → Upstream request budget](../../docs/DESIGN.md#upstream-request-budget).
- **The request ledger** (`upstream_requests`, or `var/rt-history/requests.json`) counts every attempt in the last 24 hours, including failures, and survives restarts: a restarted leader continues each feed's schedule from its last request instead of polling at once, and serves the last recorded snapshot meanwhile. `/rt/status` reports `budget`.
- **Backoff**: on upstream errors it keeps serving the last snapshot, marked `stale` with its age, and backs off: the interval doubles with each consecutive failure, up to 5 minutes (or the normal interval, if that's longer). Retries spend budget too. Errors never include the request URL, which contains the key.
- **Recorder**: every poll is recorded for **every route**: to `rt_positions` (partitioned by day) and to hourly files, `var/rt-history/YYYY-MM-DD/HH.ndjson.gz`, one line per snapshot. `/rt/history` filters a closed hour to the routes we draw (and caches it). `/rt/coverage` returns the ranges where the recorder was running (gaps longer than the poll interval allows count as uncovered).
- **Service changes**: each trip-updates and alerts poll updates the service date's cancelled trips, skipped stops and route alerts, with when each was first and last seen (`trip_changes`, `alerts`, and `var/rt-history/changes/YYYYMMDD.json`). They exist because the feeds forget a trip once it has run and an alert once it's over. The site refetches today's and yesterday's every minute.
- **Alert drafts**: SkyTrain alerts the parser understands become draft disruptions in the review queue (or `regions/metro-vancouver/disruptions/drafts/` without a database); others are listed as unparsed in `/admin` ([packages/transit-core/DESIGN.md → Disruptions and alerts](../../packages/transit-core/DESIGN.md#disruptions-and-alerts)).
- **AIS**: one WebSocket to aisstream.io (which allows 3 per account) for the SeaBus fleet's MMSIs, reconnecting with backoff; two days of fixes in memory, recorded every 10 s (`ais_fixes` and `var/ais-history/`). Matching happens in the browser ([packages/transit-core/DESIGN.md → SeaBus AIS](../../packages/transit-core/DESIGN.md#seabus-ais)).
- Polling needs `RT_POLL=1`. Without it, keys in `.secrets` or the environment are ignored: only production polls, because the key's budget is shared.

## Live dispatch and previews

`src/rt/dispatch.ts`. The leader runs the [dispatcher](../../packages/transit-core/DESIGN.md#dispatcher) for every date whose confirmed observations or disruptions change (checked every `dispatchCheckS`), in the background. Each result is a version: a patch of the runs that differ from the published build, named by a content hash of its inputs, stored in `dispatch_versions` and `var/dispatch-history/`, and kept. `/rt/live` and `/rt/dispatch` advertise the current version per date; `/rt/dispatch/<date>/<version>.json` serves a patch, cacheable forever. A restart reloads them.

A patch only fits the build it was dispatched against (`baseBuiltAt`), which is why this server also builds and publishes the transit data (the `data` job below).

**Previews**: `POST /admin/api/{disruptions|observations}/<id>/preview` dispatches the dates a draft touches (within a week of today) with it added, as versions that aren't advertised. `/admin` links to `/transit?preview=<YYYYMMDD>:<version>` ([docs/DESIGN.md → Corrections and previews](../../docs/DESIGN.md#corrections-and-previews)).

## Jobs

`src/jobs/`. The leader checks every 5 minutes and runs whatever is due, one job at a time. `job_runs` (in `packages/db`) makes each (job, key) run once and retries failures on the next tick, so missed days are caught up after downtime; runs a previous leader left "running" are reset when a new leader starts.

| Job | Key | What |
|---|---|---|
| `partitions` | UTC date | Create the next days' and months' partitions |
| `retention` | local date | Drop raw data older than `retentionDays` (60): partitions, hour files, and their archive copies |
| `daily` | service date | Observed stop times and per-route statistics for each finished service date still within retention (`src/jobs/daily.ts`, with `packages/transit-core/src/rt/observed.ts` and `stats.ts`). `npm run stats -- <YYYYMMDD>` reruns one. |
| `data` | local date | With `BUILD_DATA=1`, at `dataBuildAt`: build the transit data (the pipelines, in a child process) with the confirmed corrections from the database, publish it to `DATA_PUBLISH_REMOTE`, and archive new GTFS feeds. Also runs at once on a server with nothing to serve. |
| `archive` | local hour | Copy closed recordings to `ARCHIVE_REMOTE` |

Backups run in their own container (`infra/backup/`) and record themselves in `job_runs`. `/healthz` fails when a daily job (statistics, data build, backup) failed in the last 3 days or hasn't succeeded for 36 hours.

## Trackside cameras

`src/trackside.ts` ([packages/trackside](../../packages/trackside/README.md#reports)). Phones running `/trackside` upload each train they see to `POST /admin/api/trackside/passes` (admins only, ≤ 2 MB): the report is validated (`passProblems`) and stored once by its device-made id, in `trackside_passes` with the number crops in `trackside_crops`, or without a database as one JSON file per pass under `var/trackside/passes/<UTC date>/` and crops under `var/trackside/crops/<id>/`. `GET /admin/api/trackside/passes?limit=` lists the latest with crop metadata, and `GET /admin/api/trackside/crops/<id>/<n>` serves a crop. Nothing feeds the dispatcher yet.

## Admin API and sign-in

`src/auth.ts`, `src/app.ts`, `src/corrections.ts`. Admins sign in with GitHub: `/auth/github/login` redirects to GitHub (public profile only), and the callback creates a session and sends the browser to `<SITE_URL>/admin#token=…` (or `/trackside#token=…` with `?page=trackside`: that page runs as a home-screen app with storage of its own). The site keeps the token and sends `Authorization: Bearer …`; only its SHA-256 is stored, and sessions last 30 days. Only logins listed in `ADMIN_GITHUB_LOGINS` can sign in, and removing a login revokes its access at once. Everyone else is anonymous for now.

`/admin/api` lists corrections (and unparsed alerts), edits disruptions and observation sets (an edit to a confirmed one sends it back to draft), previews, confirms, discards and reopens them, exports the confirmed ones in the file format, and reports status, health and recent jobs. A disruption can't be confirmed without saying which track stays open.

`ADMIN_DEV_TOKEN` signs anyone presenting it in as an admin, for local development; the server refuses to start with it unless `PUBLIC_URL` is local.

## Settings

From the environment (`src/env.ts`; production values in `infra/.env.example`):

| Variable | |
|---|---|
| `DATABASE_URL` | PostgreSQL; without it, files only |
| `RT_POLL=1` | Poll TransLink and aisstream.io (production only) |
| `RT_FORWARD_TO` | Forward `/rt/*` to another server instead of polling (local development) |
| `ADVERTISE_URL` | How followers reach this process if it becomes the leader |
| `PUBLIC_URL`, `SITE_URL` | This server's public URL (for the sign-in callback), and the site's |
| `ALLOWED_ORIGINS` | Origins allowed to call `/admin/api` and `/auth` (`*` matches one subdomain label) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_LOGINS` | Admin sign-in |
| `ADMIN_DEV_TOKEN` | A fixed admin token, local only |
| `JOBS` | Run the leader's jobs (default on) |
| `BUILD_DATA=1`, `DATA_PUBLISH_REMOTE`, `ARCHIVE_REMOTE` | Build and publish the transit data; rclone destinations for it and the archive |
| `TRANSLINK_API_KEY`, `AISSTREAM_API_KEY` | Upstream keys (or `.secrets`); used only with `RT_POLL=1` |

The server refuses to start on outdated time zone data (`timezoneChecks` in `regions/metro-vancouver/region.json`).

## Command-line tools

- `npm run db:import-history`: import `var/{rt,ais,dispatch}-history` into the database (idempotent).
- `npm run stats -- <YYYYMMDD>`: recompute a date's observed stop times and statistics.
- `npm run corrections -- export <dir> | import [<dir>] | pull`: move corrections between the database and the file format.

Tests (`test/`) use a scratch database when `TEST_DATABASE_URL` is set.
