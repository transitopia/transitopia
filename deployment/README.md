## Deployment Notes

### Map tiles (map-tiles.transitopia.org)

Map data is served from PMTiles vector map files hosted on CloudFlare R2 (bucket `transitopia-maps`)
by a CloudFlare worker (`worker.js`), as described in the PMTiles documentation at
https://docs.protomaps.com/deploy/cloudflare. A file `<name>.pmtiles` in the bucket is served as
`https://map-tiles.transitopia.org/<name>.json`.

| File | Built by |
|---|---|
| `protomaps-bc.pmtiles` (the basemap) | `.github/workflows/build_basemap.yml`, weekly (`npm run tiles -- --region bc`) |
| `transitopia-cycling-british-columbia.pmtiles` | `.github/workflows/build_cycling.yml`, daily (`map-layers/`) |

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
https://dash.cloudflare.com AND view the site in an incognito window.

TODO: maybe put a version string in the filename so it clears the cache better,
and/or so we can have time-travel maps / map history in the future (once map
format is stabilized). https://github.com/transitopia/transitopia/issues/8

### Transit data (data.transitopia.org)

`/transit` reads its published data (`data/manifest.json`, plans, movements, track network, dispatch
patches) from `https://data.transitopia.org/`. `.github/workflows/build_transit_data.yml` rebuilds
it daily and uploads it to the R2 bucket `transitopia-data`.

One-time setup (done):

1. Create the R2 bucket `transitopia-data` and connect the custom domain `data.transitopia.org`.
2. Add a CORS policy allowing `GET` and `HEAD` from `https://www.transitopia.org` (and
   `https://transitopia.org`, `https://*.transitopia-web.pages.dev`, `http://localhost:5173`).
3. Cache: `data/manifest.json` should be short-lived (e.g. 5 minutes); everything else can be cached
   for longer. (Content-hashed paths are planned, V2-PLAN.md §5.2.) The workflow stores
   `Cache-Control` on each object when it uploads (5 minutes for the manifest, a day for the rest),
   and a Cache Rule for `data.transitopia.org` makes the edge follow it (Cloudflare doesn't cache
   `.json` by default). Set the same headers when uploading by hand, or an overwrite drops them.
4. Add GitHub secrets `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_ACCESS_KEY_ID` and
   `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_SECRET_ACCESS_KEY` (an R2 API token that can write the bucket;
   the endpoint is shared with the maps bucket).

### The website (www.transitopia.org)

A static build of `apps/web` on Cloudflare. Since V2 the app lives in `apps/web`
and the repo is an npm workspace, so the Cloudflare build settings need:

- Root directory: the repository root
- Build command: `npm ci && npm run build -w @transitopia/web`
- Output directory: `apps/web/dist`
- `CF_WEB_ANALYTICS_TOKEN`: the Cloudflare Web Analytics site token (optional; V2-PLAN.md §7.6).
  Alternatively, turn on Web Analytics in the Cloudflare dashboard, which injects the beacon itself.

Production data locations are in `apps/web/.env.production`.

### The server (api.transitopia.org)

The server (`apps/server`, V2-PLAN.md §4.3, §7) runs on a FullHost VM in Toronto with Docker
Compose (`infra/compose.yml`): the server, PostgreSQL + PostGIS, Caddy for TLS, and a backup
container. Cloudflare proxies `api.transitopia.org` to it. The leader server:

- polls TransLink within the daily budget and streams SeaBus AIS, recording every route (database
  and hourly files; raw data is kept 60 days);
- serves `/rt/*` to the site, re-dispatches dates with corrections, and serves `/admin/api`;
- builds the transit data daily at 03:30 and publishes it to `data.transitopia.org` (R2), then
  archives new GTFS feeds;
- computes observed stop times and route statistics for each finished service date;
- copies closed recordings to the archive bucket hourly.

Backups: `pg_dump` nightly at 11:30 UTC to `<ARCHIVE_REMOTE>/backups/db/` (30 days), plus a
developer snapshot without users, sessions or raw rows (`npm run snapshot:pull -- --db`).

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
| `build-rt-profile` on 75 h of history | 0.4 GB (was 12 GB before fix fe149ee) | 2 s |
| PostgreSQL (default settings) during the statistics job | 0.2 GB | |

Jobs run one at a time, so the server container stays under ~1.5 GB, and the whole stack under
~2.5 GB: 4 GB of RAM is enough, 8 GB lets Postgres cache the recent raw data. Not measured yet: the
profile build on 28 days of history (it keeps every fix of the drawn routes in memory; estimated
under 1 GB), and real GPS data rather than synthetic positions.

Disk, per day of every route:

| What | Per day | Kept | Total |
|---|---|---|---|
| Raw positions in Postgres (with indexes) | 128 MB | 60 days | ~7.7 GB |
| Hourly files (gzipped), plus the same in the archive bucket | 12 MB | 60 days | ~0.75 GB |
| Observed stop times in Postgres (665,000 rows) | 215 MB | indefinitely | **~78 GB a year** |
| Route statistics, trip changes, alerts, dispatch versions | < 5 MB | indefinitely | small |

Observed stop times dominate: kept in Postgres they grow by ~78 GB a year, which a 160 GB disk
holds for under two years. V2-PLAN.md §4.4 plans monthly files in object storage with only recent
months in Postgres; that export isn't built yet and should be before the disk fills.

#### Monitoring

`/healthz` returns 503 when positions polls or AIS go stale, the database is unreachable, or a
daily job (statistics, data build, backup) failed or hasn't succeeded for 36 hours. An uptime
monitor watches it ([api-server-setup.md, step 13](api-server-setup.md#13-uptime-monitor)). The
response body says which check failed; `/admin` shows the same, plus recent jobs.

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
- Restore a backup (test quarterly, V2-PLAN.md §7.3, on a scratch database or VM):

      rclone copy r2:transitopia-archive/backups/db/transitopia-<date>.dump .
      createdb restore_test && pg_restore -d restore_test transitopia-<date>.dump

- The server's data lives in two Docker volumes: `transitopia_db` (PostgreSQL) and
  `transitopia_var` (recordings, GTFS downloads, build output). The archive bucket holds copies of
  closed recordings and every GTFS feed.
- `.github/workflows/build_transit_data.yml` is now a manual fallback: running it while the server
  publishes replaces the server's build, and live dispatch patches won't fit until the server's
  next build.
