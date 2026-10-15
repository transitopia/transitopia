# Transitopia server

The server behind `api.transitopia.org` (Node, TypeScript, [Hono](https://hono.dev)). It serves real-time data to the site for every region, and on the leader it polls each feed's GTFS-realtime within its request budget ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)), streams SeaBus AIS, records everything, re-dispatches SkyTrain when corrections change, and runs the scheduled jobs. How it fits with the rest: [docs/DESIGN.md](../../docs/DESIGN.md). Hosting and operations: [deployment/README.md](../../deployment/README.md#the-server-apitransitopiaorg).

```sh
# run using schedules only: no polling of real-time APIs
npm run server
# run with production's live data
RT_FORWARD_TO=https://api.transitopia.org npm run server
# Start using local PostgreSQL (infra/compose.dev.yml):
npm run db:up
DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/transitopia npm run server
```

Run the site against it with `VITE_TRANSIT_API=http://localhost:8787/ npm run dev`. Without `DATABASE_URL` the server records to files only (`var/rt-history/<feed>/`, `var/ais-history/`, `var/dispatch-history/`), uses a lock file for leadership, and reads corrections from `regions/metro-vancouver/{observations,disruptions}/`.

## API

```
GET /regions/<id>/live/transit      every live source for a region's transit map, one response for everyone (below)
GET /regions/<id>/days/<YYYYMMDD>/seabus/ais                 SeaBus AIS fixes recorded for a service date so far (Metro Vancouver)
GET /regions/<id>/days/<YYYYMMDD>/<feed>/changes             a feed's bus trips cancelled or skipping stops, and bus route alerts, for a service date
GET /regions/<id>/days/<YYYYMMDD>/<feed>/changes/<v>.json    a version of them (immutable)
GET /rt/history?feed=<id>&date=YYYY-MM-DD&hour=HH   a feed's recorded snapshots for one local hour (NDJSON, drawn routes only)
GET /rt/coverage?feed=<id>&from=ms&to=ms            a feed's recorder coverage intervals
GET /rt/status                      each feed's poller health and budget, AIS (no secrets)
GET /rt/alerts                      current TransLink alerts for our rail lines, and whether each was drafted
GET /rt/dispatch                    live dispatch: current patch version per service date
GET /rt/dispatch/<date>/<v>.json    a patch version (immutable)
GET /rt/live, /rt/ais/fixes?date=YYYYMMDD[&after=cursor], /rt/changes?date=YYYYMMDD   replaced by the above, until #178 removes them
GET /healthz                        data freshness: 503 when polls (or trip updates' delays), AIS, the database or a daily job are stale
GET /auth/github/login, /auth/github/callback, /auth/me; POST /auth/logout     admin sign-in
/admin/api/*                        the review queue behind /admin (admins only)
```

`/rt/*` and `/regions/*` are public, with CORS for everyone, and cached at Cloudflare's edge, so server load doesn't grow with visitors. The server serves every region in `regions/*/region.json` (other ids are a 404) and polls every feed they show; `feed` defaults to `translink` where it's a parameter, as before feeds had ids. `/admin/api` and `/auth` allow only `ALLOWED_ORIGINS`.

## Leader

Exactly one process polls, records, dispatches and runs jobs: the leader (`src/leader.ts`), elected by a Postgres advisory lock (a lock file without a database). Other instances forward `/rt/*` to it (`ADVERTISE_URL`) and take over when it goes away. If the leader loses the lock's database connection, it exits so it can restart cleanly.

## Real-time service

`src/rt/service.ts`, `feed.ts`, `upstream.ts`, `recorder.ts`, `changes.ts`, `alerts.ts`, `ais.ts`. `RtService` runs one `FeedPoller` (`feed.ts`) per feed with real time; everything below is per feed unless it says otherwise.

- **One upstream poller per feed**: a loop per endpoint fetches positions, trip updates (delays, cancellations, skipped stops) and alerts from the URLs in `feeds/<feed>/feed.json` → `realtime` (with its key, where it needs one) on the feed's time-of-day schedule (`realtime.poll`), regardless of how many clients are connected. Client requests never trigger upstream fetches; they read the latest cached snapshot. The schedule and the hard cap are described in [docs/DESIGN.md → Upstream request budget](../../docs/DESIGN.md#upstream-request-budget).
- **The request ledger** (`upstream_requests` with the feed id as `provider`, or `var/rt-history/<feed>/requests.json`) counts every attempt in the last 24 hours, including failures, and survives restarts: a restarted leader continues each feed's schedule from its last request instead of polling at once, and serves the last recorded snapshot meanwhile. `/rt/status` reports `budget`.
- **Backoff**: on upstream errors it keeps serving the last snapshot, marked `stale` with its age, and backs off: the interval doubles with each consecutive failure, up to 5 minutes (or the normal interval, if that's longer). Retries spend budget too. Errors never include the request URL, which contains the key. Each feed's last success and last error are kept apart (`/rt/status` → `feeds`), so a positions poll can't hide a failing trip-updates feed. `delayCoverage` is the share of the latest positions' buses (on a trip) with a TransLink delay, 75–85 % normally; `/healthz` fails when trip updates are stale (no success for 3 poll intervals) or it falls below the feed's `tripUpdatesMinCoverage`, which is how a feed that answers but no longer matches the positions shows up (seen from 04:00 on 2026-10-12). A restarted leader continues the schedule instead of polling at once, so until trip updates' first success their age counts from when it started polling (`/rt/status` → `pollingForS`): a deploy doesn't fail the check, but a feed that stays down from the start still does. To tell an empty feed from one whose trip ids don't match the buses', each trip-updates poll is summarised against the trips in the latest positions poll (`/rt/status` → `tripFeed`: trips in the feed, with stop delays, matched both ways, the feed's age and size, and a few unmatched trip ids each way), and logged while fewer than `tripUpdatesMinCoverage` of the buses' trips are in it. Response sizes go to `upstream_requests.bytes`.
- **Recorder**: every poll is recorded for **every route**: to `rt_positions` (partitioned by day, with its `feed_id`) and to hourly files, `var/rt-history/<feed>/YYYY-MM-DD/HH.ndjson.gz`, one line per snapshot. `/rt/history` filters a closed hour to the routes we draw (and caches it). `/rt/coverage` returns the ranges where the recorder was running (gaps longer than the poll interval allows count as uncovered).
- **Service changes**: each trip-updates and alerts poll updates the service date's cancelled trips, skipped stops and route alerts, with when each was first and last seen (`trip_changes`, `alerts`, and `var/rt-history/changes/YYYYMMDD.json`). They exist because the feeds forget a trip once it has run and an alert once it's over. Each state of a day is a version (a hash of its content): the live endpoint points to today's and yesterday's, and the server keeps the last few of each so a pointer a poll or two old still resolves.
- **Alert drafts** (Metro Vancouver's feed only): SkyTrain alerts the parser understands become draft disruptions in the review queue (or `regions/metro-vancouver/disruptions/drafts/` without a database); others are listed as unparsed in `/admin` ([packages/transit-core/DESIGN.md → Disruptions and alerts](../../packages/transit-core/DESIGN.md#disruptions-and-alerts)).
- **AIS**: one WebSocket to aisstream.io (which allows 3 per account) for the SeaBus fleet's MMSIs, reconnecting with backoff; two days of fixes in memory, recorded every 10 s (`ais_fixes` and `var/ais-history/`). Each fix keeps the time of the batch it was recorded in, which is how the day files and the live window meet (below). Matching happens in the browser ([packages/transit-core/DESIGN.md → SeaBus AIS](../../packages/transit-core/DESIGN.md#seabus-ais)).
- Polling needs `RT_POLL=1`, for every feed, keyless ones (BC Transit) included. Without it, keys in `.secrets` or the environment are ignored: only production polls, because the key's budget is shared.

## Live endpoint

`GET /regions/<id>/live/transit` (`liveTransit()` in `src/rt/service.ts`; the format is `packages/transit-core/src/rt/live.ts`) is the one thing the transit map polls. It's the same for every visitor, so the edge shares it, and it has a section per live source, keyed by source id: `<feed>/vehicles` and `<feed>/changes` for each of the region's feeds with real time (`translink/vehicles`, `bc-transit-victoria/vehicles`), and in Metro Vancouver `seabus/ais` and `dispatch`. Each has a `kind` so a reader takes the ones it understands.

- **Inline, in compact formats**: the latest positions poll (`vehicles`, the `/rt/history` line format, sent only while not stale) and a trailing window of AIS batches (`ais`, `encodeFixes` rows). Each data section has its own `status` (`ok`, `stale`, `unavailable`) and `error`, so a stalled AIS stream doesn't mark the buses stale.
- **Pointers**: service changes and dispatch patches are a version per service date with the path of an immutable file, fetched only when the version changes.
- **AIS window and day files**: the window holds the batches recorded in `config/seabus.json` → `ais.liveWindowS` up to the latest batch with fixes (`from`, exclusive, to `to`). A date's earlier fixes come from its day file (`/days/<date>/seabus/ais`, complete through its `to`, cached 60 s, or a day once the date is over). Both count by batch time, so a browser whose day file reached a window's `from` has every fix; if not (the tab slept), it refetches the day file.
- **Caching**: the body holds no request time or ages, so it only changes with the data. It carries a weak `ETag`, and a matching `If-None-Match` gets a 304 (also through the proxies, which may append `-gzip` to it). `nextAt` is when the next upstream poll or AIS batch with fixes is due; `max-age` runs until then, at most `config/rt.json` → `clientPollS`, and browsers poll shortly after it (`clientPollSlackS`), but no more often than every `clientPollS` and at least every `clientPollMaxS`.

## Live dispatch and previews

`src/rt/dispatch.ts`. The leader runs the [dispatcher](../../packages/transit-core/DESIGN.md#dispatcher) for every date whose confirmed observations or disruptions change (checked every `dispatchCheckS`), in the background. Each result is a version: a patch of the runs that differ from the published build, named by a content hash of its inputs, stored in `dispatch_versions` and `var/dispatch-history/`, and kept. The live endpoint and `/rt/dispatch` advertise the current version per date; `/rt/dispatch/<date>/<version>.json` serves a patch, cacheable forever. A restart reloads them.

A patch only fits the build it was dispatched against (`baseBuiltAt`), which is why this server also builds and publishes the transit data (the `data` job below).

**Previews**: `POST /admin/api/{disruptions|observations}/<id>/preview` dispatches the dates a draft touches (within a week of today) with it added, as versions that aren't advertised. `/admin` links to `/transit?preview=<YYYYMMDD>:<version>` ([docs/DESIGN.md → Corrections and previews](../../docs/DESIGN.md#corrections-and-previews)).

## Jobs

`src/jobs/`. The leader checks every 5 minutes and runs whatever is due, one job at a time. `job_runs` (in `packages/db`) makes each (job, key) run once and retries failures on the next tick, so missed days are caught up after downtime; runs a previous leader left "running" are reset when a new leader starts.

| Job | Key | What |
|---|---|---|
| `partitions` | UTC date | Create the next days' and months' partitions |
| `retention` | local date | Drop raw data older than `retentionDays` (60): partitions, hour files, and their archive copies |
| `daily` | feed:service date | A feed's observed stop times and per-route statistics for each finished service date still within retention (`src/jobs/daily.ts`, with `packages/transit-core/src/rt/observed.ts` and `stats.ts`). `npm run stats -- <YYYYMMDD>` reruns one. |
| `data` | local date | With `BUILD_DATA=1`, at `dataBuildAt`: build the transit data (the pipelines, in a child process) with the confirmed corrections from the database, publish it to `DATA_PUBLISH_REMOTE`, and archive new GTFS feeds. Also runs at once when a feed has nothing published yet (a new server, or a feed just added). |
| `archive` | local hour | Copy closed recordings to `ARCHIVE_REMOTE` |

Backups run in their own container (`infra/backup/`) and record themselves in `job_runs`. `/healthz` fails when a daily job (statistics, data build, backup) failed in the last 3 days or hasn't succeeded for 36 hours.

## Admin API and sign-in

`src/auth.ts`, `src/app.ts`, `src/corrections.ts`. Admins sign in with GitHub: `/auth/github/login` redirects to GitHub (public profile only), and the callback creates a session and sends the browser to `<SITE_URL>/admin#token=…`. The site keeps the token and sends `Authorization: Bearer …`; only its SHA-256 is stored, and sessions last 30 days. Only logins listed in `ADMIN_GITHUB_LOGINS` can sign in, and removing a login revokes its access at once. Everyone else is anonymous for now.

`/admin/api` lists corrections (and unparsed alerts), edits disruptions and observation sets (an edit to a confirmed one sends it back to draft), previews, confirms, discards and reopens them, exports the confirmed ones in the file format, and reports status, health, recent jobs, every `daily` run within retention (observed stop rows and trips per service date) and the database's size per table (for [sizing](../../deployment/README.md#sizing)). A disruption can't be confirmed without saying which track stays open. Its requests and responses are zod schemas in [`@transitopia/shared/admin-api.ts`](../../packages/shared/README.md): `app.ts` checks its responses against them (`satisfies`) and parses request bodies with them, and `/admin` parses what it gets back.

`ADMIN_DEV_TOKEN` signs anyone presenting it in as an admin, for local development; the server refuses to start with it unless `PUBLIC_URL` is local.

## Settings

From the environment (`src/env.ts`; production values in `infra/.env.example`):

| Variable | |
|---|---|
| `DATABASE_URL` | PostgreSQL; without it, files only |
| `RT_POLL=1` | Poll every feed's GTFS-realtime and aisstream.io (production only) |
| `RT_FORWARD_TO` | Forward `/rt/*` to another server instead of polling (local development) |
| `ADVERTISE_URL` | How followers reach this process if it becomes the leader |
| `PUBLIC_URL`, `SITE_URL` | This server's public URL (for the sign-in callback), and the site's |
| `ALLOWED_ORIGINS` | Origins allowed to call `/admin/api` and `/auth` (`*` matches one subdomain label) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_LOGINS` | Admin sign-in |
| `ADMIN_DEV_TOKEN` | A fixed admin token, local only |
| `JOBS` | Run the leader's jobs (default on) |
| `BUILD_DATA=1`, `DATA_PUBLISH_REMOTE`, `ARCHIVE_REMOTE` | Build and publish the transit data; rclone destinations for it and the archive |
| `TRANSLINK_API_KEY`, `AISSTREAM_API_KEY` | Upstream keys (or `.secrets`); used only with `RT_POLL=1` |

The server refuses to start on outdated time zone data (`timezoneChecks` in each `region.json`). It upserts the `regions` and `feeds` tables from the files when it starts (`src/sources.ts`; the import and statistics tools do too, since rows of a feed reference it), and moves files recorded before feeds had ids into TransLink's directories (`packages/data/src/legacy.ts`). Its own settings (port, recording, live dispatch) are still read from Metro Vancouver's `config/`.

## Command-line tools

- `npm run db:import-history`: import `var/rt-history/<feed>/`, `var/{ais,dispatch}-history` into the database (idempotent).
- `npm run stats -- <YYYYMMDD> [--feed <id>]`: recompute a date's observed stop times and statistics (every feed with real time, or one).
- `npm run corrections -- export <dir> | import [<dir>] | pull`: move corrections between the database and the file format.

Tests (`test/`) use a scratch database when `TEST_DATABASE_URL` is set.
