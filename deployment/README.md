## Deployment Notes

How Transitopia is hosted, deployed and operated. The system's design is in [docs/DESIGN.md](../docs/DESIGN.md).

### Hosting

| Host | Serves | Where |
|---|---|---|
| `www.transitopia.org` | The site (`apps/web`) | Cloudflare Pages (`transitopia-web`), built from `prod` |
| `map-tiles.transitopia.org` | Basemap and cycling tiles | A Cloudflare worker (`worker.js`) over the R2 bucket `transitopia-maps` |
| `data.transitopia.org` | The published transit data | The R2 bucket `transitopia-data` |
| `api.transitopia.org` | The server (`apps/server`) | A FullHost VM in Toronto, behind Cloudflare's proxy (only Cloudflare can connect) |

- **FullHost** (Canadian, with data centres in Vancouver, Calgary, Toronto and Montreal): the VM is Ubuntu 26.04 LTS, 4 vCPU, 8 GB RAM, 100 GB SSD, $36/month, in Toronto. Vancouver only offered a 2 vCPU plan at $48; the ~60–70 ms from Vancouver doesn't matter behind Cloudflare's cache, and local times come from the region's time zone, never the host's. Docker Compose runs the server, PostgreSQL (PostGIS), Caddy and backups.
- **Cloudflare**: DNS, the static site, the CDN and edge cache (including the live endpoint and the published data), WAF and rate limiting in front of `api.transitopia.org`, the tile worker, Web Analytics, and **R2**: `transitopia-maps` (tiles), `transitopia-data` (published transit data) and the private `transitopia-archive` (backups, raw recordings, GTFS feeds, developer snapshots). R2 has no Canadian location; nothing here is sensitive. Keeping all object storage at one provider means one toolchain (rclone), no egress fees for snapshot pulls, and backups at a different provider from the VM.
- Bucket locations are settings (`DATA_PUBLISH_REMOTE`, `MAPS_PUBLISH_REMOTE`, `ARCHIVE_REMOTE`), and everything runs as portable Docker and S3, so either part can move.

### Environments

Production and local development. Local development never polls TransLink (the key's 1,000 requests a day belong to production): it forwards to production's API or uses snapshots ([below](#snapshots-for-development)). A staging environment can be added cheaply: configuration is in env files, hostnames and buckets are settings, migrations run unattended, and a second Compose project on the same VM (with its own database and buckets) would do. Staging would never poll TransLink either.

### Branches

Work happens on feature branches merged into `main`. Production deploys from `prod`: merge `main` into `prod` and push. Cloudflare
Pages builds the site from `prod`, and `.github/workflows/deploy_server.yml` deploys the server.
Scheduled workflows (the basemap and cycling builds) run from `main`, the default branch.

The VM's checkout at `/opt/transitopia` stays detached at `origin/prod`. To update it by hand, do
what the deploy workflow does, not `git pull`:

    git -C /opt/transitopia fetch -q origin prod && git -C /opt/transitopia checkout -q --detach origin/prod

### Map tiles (map-tiles.transitopia.org)

Map data is served from PMTiles vector map files hosted on CloudFlare R2 (bucket `transitopia-maps`)
by a CloudFlare worker (`worker.js`), as described in the PMTiles documentation at
https://docs.protomaps.com/deploy/cloudflare. A file `<name>.pmtiles` in the bucket is served as
`https://map-tiles.transitopia.org/<name>.json`.

| File | Built by |
|---|---|
| `protomaps-bc.pmtiles` (the basemap) | `.github/workflows/build_basemap.yml`, weekly (`npm run tiles -- --region bc`) |
| `transitopia-cycling-british-columbia.pmtiles` | `.github/workflows/build_cycling.yml`, daily (`npm run data:cycling`, [packages/cycling-core](../packages/cycling-core/README.md)) |
| `transit-overview-v<N>.pmtiles` (every region's routes zoomed out) | The server's daily data build (`npm run build:overview-tiles`), uploaded to `MAPS_PUBLISH_REMOTE` ([packages/transit-core → Overview tiles](../packages/transit-core/DESIGN.md#overview-tiles)) |

The worker's `ALLOWED_ORIGINS` variable lists the sites allowed to use the tiles (CORS), comma
separated. It keeps other websites from building maps on our tiles and using up our Cloudflare
allowance. It doesn't stop non-browser clients. Entries may use `*` for one subdomain label, which
is a Transitopia change to the upstream worker:

    https://www.transitopia.org,https://transitopia.org,https://*.transitopia-web.pages.dev,http://localhost:5173

`worker.js` isn't deployed by CI: after changing it, paste it into the worker in the Cloudflare
dashboard (or deploy it with wrangler).

To upload by hand:

    rclone copy var/public/tiles/protomaps-bc.pmtiles transitopia-r2:transitopia-maps --s3-no-check-bucket

The changes will not be visible for a while (4 hours?) unless you purge the cache at
https://dash.cloudflare.com AND view the site in an incognito window. Versioned file names would
avoid that ([#8](https://github.com/transitopia/transitopia/issues/8)).

### Transit data (data.transitopia.org)

`/transit` reads its published data (each feed's `data/feeds/<feed>/manifest.json`, plans, movements,
and each region's `data/regions/<id>/` track network and dispatch patches;
[docs/DESIGN.md → Regions and feeds](../docs/DESIGN.md#regions-and-feeds)) from `https://data.transitopia.org/`.
Uploads copy, never sync, so files a build no longer writes stay until deleted by hand. The server builds it daily (its `data` job, at
`dataBuildAt` in `config/server/recording.json`) and uploads it to the R2 bucket
`transitopia-data`, so its live dispatch patches fit the published plans.
`.github/workflows/build_transit_data.yml` is a manual fallback only (see the comment at its top).

One-time setup (done):

1. Create the R2 bucket `transitopia-data` and connect the custom domain `data.transitopia.org`.
2. Add a CORS policy allowing `GET` and `HEAD` from `https://www.transitopia.org` (and
   `https://transitopia.org`, `https://*.transitopia-web.pages.dev`, `http://localhost:5173`), with
   the `Range` request header allowed and `ETag` exposed: the site reads each plan's tiles
   (`data/feeds/<feed>/lines/<hash>.pmtiles`) by range requests through the pmtiles protocol.
3. Cache: the manifests (`data/feeds/*/manifest.json`), the places indexes (`data/feeds/*/places.json`) and `data/features/latest.json` should be short-lived (e.g. 5 minutes); everything else can be cached
   for longer. Each build rewrites files at the same paths, so the site asks for every other file with
   the build in its URL (`?v=<the manifest's generatedAt>`, `PlanStore.dataUrl` in
   `packages/transit-map/src/plans.ts`): after a build, browsers and the edge fetch the new file
   instead of serving the old one for a day, once the manifest's 5 minutes are up. A tab open across a build still holds the old manifest: when a plan it asks for can't be read, the site checks the manifest again and restarts the map on the new build. The Cache Rule
   must keep the query string in the cache key (Cloudflare's default). The upload stores
   `Cache-Control` on each object when it uploads (5 minutes for the manifest, a day for the rest),
   and a Cache Rule for `data.transitopia.org` makes the edge follow it (Cloudflare doesn't cache
   `.json` by default). Plan tiles are named by their content, so they're asked for without
   the build in the URL; they're uploaded as they are (tippecanoe compresses each tile). Upload by
   hand with `npm run publish:data -- <remote>`, never a bare `rclone copy`: an overwrite drops the
   headers, and the files must go up compressed. The upload passes `--no-update-modtime`: when only
   a file's time changed, rclone otherwise updates it by copying the object onto itself with new
   metadata, which drops the headers too.
4. Compression: the upload compresses every JSON and GeoJSON file with brotli at its highest
   quality (`apps/server/src/jobs/publish.ts`; staged in `var/publish/data`, recompressed only when
   the file changes) and stores it with `Content-Encoding: br` and `Cache-Control: …, no-transform`,
   so the edge serves our copy as it is instead of compressing the plain file itself, which it does
   at about brotli quality 4, or with zstd for browsers that accept it (Chrome): a weekday plan was
   122 KB that way, 84 KB at quality 11. Clients that accept brotli get our copy as stored, even
   when they also accept zstd; for the rest (`curl`, Node's `fetch`), the edge decodes it (tested
   2026-10-19).
5. For the fallback workflow, add GitHub secrets `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_ACCESS_KEY_ID` and
   `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_SECRET_ACCESS_KEY` (an R2 API token that can write the bucket;
   the endpoint is shared with the maps bucket).

### The website (www.transitopia.org)

A static build of `apps/web` on Cloudflare. Since V2 the app lives in `apps/web`
and the repo is an npm workspace, so the Cloudflare build settings need:

- Root directory: the repository root
- Build command: `npm ci && npm run build -w @transitopia/web`
- Output directory: `apps/web/dist`
- `CF_WEB_ANALYTICS_TOKEN`: the Cloudflare Web Analytics site token (optional; [apps/web → Analytics](../apps/web/README.md#analytics)).
  Alternatively, turn on Web Analytics in the Cloudflare dashboard, which injects the beacon itself.

Production data locations are in `apps/web/.env.production`.

### The server (api.transitopia.org)

The server ([apps/server](../apps/server/README.md)) runs on a FullHost VM in Toronto with Docker
Compose (`infra/compose.yml`): the server, PostgreSQL + PostGIS, Caddy for TLS, and a backup
container. Cloudflare proxies `api.transitopia.org` to it. The leader server:

- polls TransLink within the daily budget and streams SeaBus AIS, recording every route (database
  and hourly files; raw data is kept 60 days);
- serves `/rt/*` to the site, re-dispatches dates with corrections, and serves `/admin/api`;
- builds the transit data daily at 03:30 and publishes it to `data.transitopia.org` (R2), then
  archives new GTFS feeds;
- computes observed stop times and route statistics for each finished service date;
- copies closed recordings to the archive bucket hourly.

Setting it up (the VM, Docker, SSH, firewall, accounts, Cloudflare, configuration and the first
start) is in [api-server-setup.md](api-server-setup.md).

#### Sizing

Measured on 2026-09-30 on a Mac (Docker for Postgres), with a synthesized weekday of every route
at the budgeted poll rate: 738 polls, 630,000 positions, up to 1,275 buses in one poll.

| What | Memory at peak | Time |
|---|---|---|
| Server as leader, live dispatch of 5 dates | 0.7 GB | |
| Recording one poll of every bus | | 20 ms |
| Statistics for one day of every route (in the server) | +0.8 GB | 27 s |
| Data build, largest step (`build-dispatch`, a child process) | 0.5 GB | 21 s |
| Data build, all steps | | ~1 min |
| `build-rt-profile` on 523 h (22 days) of every TransLink route, measured 2026-10-20 | 0.74 GB (2.0 GB while it held every fix) | 17 s |
| PostgreSQL (default settings) during the statistics job | 0.2 GB | |

Jobs run one at a time, so the server container stays under ~1.5 GB, and the whole stack under
~2.5 GB: 4 GB of RAM is enough, 8 GB lets Postgres cache the recent raw data. Not measured yet: real
GPS data rather than synthetic positions. Node sizes its heap from the container's limit (about half
of `mem_limit`, so ~1.5 GB for each process), not from the host's RAM.

Disk, per day of every route, from the synthetic TransLink weekday:

| What | Per day | Kept | Total |
|---|---|---|---|
| Raw positions in Postgres (with indexes) | 128 MB | 60 days | ~7.7 GB |
| Hourly files (gzipped), plus the same in the archive bucket | 12 MB | 60 days | ~0.75 GB |
| Observed stop times in Postgres (665,000 rows) | 215 MB | indefinitely | **~78 GB a year** |
| Route statistics, trip changes, alerts, dispatch versions | < 5 MB | indefinitely | small |

Observed stop times dominate: measured in production with all three feeds, they grow by ~73 GB a
year (below), which the VM's disk (100 GB, 96 GB usable) holds until about mid-2027. Older months need to move to
monthly files in object storage, with only recent months in Postgres
([docs/DESIGN.md → Retention and statistics](../docs/DESIGN.md#retention-and-statistics)); that
export isn't built yet and must be before the disk fills.

Measured in production on 2026-10-25 (`/admin/api/status`: `storage` for the size per table, `daily`
for the rows per service date and feed), with TransLink recorded since 10-01 and both BC Transit
feeds since 10-15:

| What | Size | Rows | Per row |
|---|---|---|---|
| Observed stop times | 4.06 GB | 14.3 M | ~285 B |
| Raw positions (not yet at 60 days) | 3.81 GB | 17.6 M | ~216 B |
| Whole database | 8.1 GB | | |

Observed stop times per service date in the first full week of every feed (10-17 to 10-23):

| Day | TransLink | Victoria | Kelowna | Total |
|---|---|---|---|---|
| Weekday | ~640,000 | ~108,000 | ~31,000 | ~780,000 |
| Saturday | ~493,000 | ~82,000 | ~19,000 | ~594,000 |
| Sunday | ~445,000 | ~71,000 | ~14,000 | ~531,000 |

That's ~700,000 rows a day on average, **~200 MB a day or ~73 GB a year**: the rows are smaller than
the synthetic day's, and BC Transit adds about as much again. Raw positions level off at ~10 GB when
the first 60 days are up (end of November 2026). The disk is 96 GB, with 25 GB used on 2026-10-25
(`df -h /`), so ~17 GB besides the database (system, images, `var/`, WAL): ~31 GB once raw positions
level off, then +0.2 GB a day. That's past a safe ~85 % (Postgres needs headroom, and the nightly dump
is staged on the same disk) around early July 2027, and full around mid-September 2027.

Checked earlier against production's first 11 days (2026-10-01 to 10-12, TransLink only), using the
job runs at `/admin/api/status`, the drawn routes' recordings and the timetable:

- **Polls**: 738 on a weekday, as assumed; ~620 on a weekend day.
- **Positions**: more buses report than the timetable has in service (1.15–1.21× on the drawn
  routes, as layovers and deadheads report too), so a weekday has ~725,000 rows rather than 630,000.
  Weekends have about half the weekday rows, so the 60-day total stays ~7.5 GB at the synthetic
  bytes per row.
- **Hourly files**: ~9 MB on a weekday and ~4.5 MB on a weekend day (scaled from the drawn routes'
  0.9 and 0.4–0.5 MB), ~0.45 GB per copy over 60 days.
- **Observed stop times**: 493,442 rows on Saturday 10-10 and 445,015 on Sunday 10-11, 90–91 % of
  the scheduled bus stop events (98 % of scheduled trips had fixes). That makes ~645,000 on a
  weekday and ~595,000 a day on average for TransLink alone.

#### Backups

`pg_dump` nightly at 11:30 UTC to `<ARCHIVE_REMOTE>/backups/db/`, keeping 30 days, from the backup
container (`infra/backup/`, a different provider from the VM). Each dump grows with the observed stop
times (850 MB on 2026-10-25, about a tenth of the database), so revisit how many to keep once they're
large. The dumps are written to the VM's disk before they're uploaded, and removed afterwards whether
or not the backup succeeded. Continuous WAL archiving (WAL-G) can replace
nightly dumps later. The backups protect the long-lived data (statistics, observed stop times,
curated corrections); git and GitHub cover the rest. Test a restore every quarter
([Operations](#operations)).

#### Snapshots for development

Developers work against real data without polling: `npm run snapshot:pull -- --from 2026-09-20 --to 2026-09-27 [--db]`
downloads recorded hours for that range from the archive bucket (the last 60 days only; older periods
have statistics and observed stop times but no raw fixes), and with `--db` restores the nightly
developer snapshot: every table except users, sessions and raw rows (the feature registry included); then
`npm run db:import-history` adds the pulled hours' positions and AIS fixes.
Without it, `npm run features -- pull` (after `npm run db:up`, or with no database at all) loads the
public registry export, so local places files carry production's IDs ([docs/DESIGN.md → Published features](../docs/DESIGN.md#published-features)). It needs rclone access to
`transitopia-archive`. Snapshots stay private to the team until each source's terms allow
publishing them ([DATA-LICENSES.md](../DATA-LICENSES.md)).

#### Monitoring

`/healthz` returns 503 when positions polls or AIS go stale, trip updates stop arriving or match
almost none of the buses for a while (each polled feed's checks, `<feed>/positions` and `<feed>/tripUpdates`; `config/server/server.json` → `tripUpdatesHealth`, overridden per feed in `feed.json` → `realtime.tripUpdatesHealth`), the database is unreachable, or a
daily job (statistics, data build, backup) failed or hasn't succeeded for 36 hours, or the disk is
more than 85 % used (`disk`: the server's `var/` volume, on the VM's one disk with the database;
`config/server/server.json` → `diskMaxUsed`; see [Sizing](#sizing)). An uptime
monitor watches it ([api-server-setup.md, step 13](api-server-setup.md#13-uptime-monitor)). The
response body says which check failed; `/admin` shows the same, plus recent jobs. A deploy doesn't
trip it: after a restart, trip updates count as fresh until 3 poll intervals after polling starts.

#### Automatic deploys

`.github/workflows/deploy_server.yml` builds the server image on every push to `prod` that touches
the server's code, pushes it to `ghcr.io/transitopia/transitopia-server`, and restarts it on the VM
(secrets and registry access: [api-server-setup.md, step 12](api-server-setup.md#12-automatic-deploys)).
Migrations run when the server starts. After changing `infra/backup/`, rebuild it on the VM:
`docker compose -f infra/compose.yml up -d --build backup`.

#### Operations

- Logs: `docker compose -f infra/compose.yml logs -f server` (or `db`, `caddy`, `backup`).
- A psql shell: `docker compose -f infra/compose.yml exec db psql -U transitopia`.
- Recompute a date's statistics: `docker compose -f infra/compose.yml exec server npm run stats -- 20261001`.
- Restore a backup (test it quarterly, on a scratch database or VM):

      rclone copy r2:transitopia-archive/backups/db/transitopia-<date>.dump .
      createdb restore_test && pg_restore -d restore_test transitopia-<date>.dump

- The server's data lives in two Docker volumes: `transitopia_db` (PostgreSQL) and
  `transitopia_var` (recordings, GTFS downloads, build output). The archive bucket holds copies of
  closed recordings and every GTFS feed.
- `.github/workflows/build_transit_data.yml` is now a manual fallback: running it while the server
  publishes replaces the server's build, and live dispatch patches won't fit until the server's
  next build.
