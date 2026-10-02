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
- **Cloudflare**: DNS, the static site, the CDN and edge cache (including `/rt/live` and the published data), WAF and rate limiting in front of `api.transitopia.org`, the tile worker, Web Analytics, and **R2**: `transitopia-maps` (tiles), `transitopia-data` (published transit data) and the private `transitopia-archive` (backups, raw recordings, GTFS feeds, developer snapshots). R2 has no Canadian location; nothing here is sensitive. Keeping all object storage at one provider means one toolchain (rclone), no egress fees for snapshot pulls, and backups at a different provider from the VM.
- Bucket locations are settings (`DATA_PUBLISH_REMOTE`, `ARCHIVE_REMOTE`), and everything runs as portable Docker and S3, so either part can move.

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
https://dash.cloudflare.com AND view the site in an incognito window. Versioned file names would
avoid that ([#8](https://github.com/transitopia/transitopia/issues/8)).

### Transit data (data.transitopia.org)

`/transit` reads its published data (`data/manifest.json`, plans, movements, track network, dispatch
patches) from `https://data.transitopia.org/`. The server builds it daily (its `data` job, at
`dataBuildAt` in `regions/metro-vancouver/config/recording.json`) and uploads it to the R2 bucket
`transitopia-data`, so its live dispatch patches fit the published plans.
`.github/workflows/build_transit_data.yml` is a manual fallback only (see the comment at its top).

One-time setup (done):

1. Create the R2 bucket `transitopia-data` and connect the custom domain `data.transitopia.org`.
2. Add a CORS policy allowing `GET` and `HEAD` from `https://www.transitopia.org` (and
   `https://transitopia.org`, `https://*.transitopia-web.pages.dev`, `http://localhost:5173`).
3. Cache: `data/manifest.json` should be short-lived (e.g. 5 minutes); everything else can be cached
   for longer (the other paths aren't content-addressed yet, and some are rewritten). The upload stores
   `Cache-Control` on each object when it uploads (5 minutes for the manifest, a day for the rest),
   and a Cache Rule for `data.transitopia.org` makes the edge follow it (Cloudflare doesn't cache
   `.json` by default). Set the same headers when uploading by hand, or an overwrite drops them.
4. For the fallback workflow, add GitHub secrets `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_ACCESS_KEY_ID` and
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

Observed stop times dominate: kept in Postgres they grow by ~78 GB a year, which the VM's 100 GB
disk holds for about a year. Older months need to move to monthly files in object storage, with only
recent months in Postgres ([docs/DESIGN.md → Retention and statistics](../docs/DESIGN.md#retention-and-statistics));
that export isn't built yet and must be before the disk fills.

#### Backups

`pg_dump` nightly at 11:30 UTC to `<ARCHIVE_REMOTE>/backups/db/`, keeping 30 days, from the backup
container (`infra/backup/`, a different provider from the VM). Each dump grows with the observed stop
times, so revisit how many to keep once they're large; continuous WAL archiving (WAL-G) can replace
nightly dumps later. The backups protect the long-lived data (statistics, observed stop times,
curated corrections); git and GitHub cover the rest. Test a restore every quarter
([Operations](#operations)).

#### Snapshots for development

Developers work against real data without polling: `npm run snapshot:pull -- --from 2026-09-20 --to 2026-09-27 [--db]`
downloads recorded hours for that range from the archive bucket (the last 60 days only; older periods
have statistics and observed stop times but no raw fixes), and with `--db` restores the nightly
developer snapshot: every table except users, sessions and raw rows. It needs rclone access to
`transitopia-archive`. Snapshots stay private to the team until each source's terms allow
publishing them ([DATA-LICENSES.md](../DATA-LICENSES.md)).

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
- Restore a backup (test it quarterly, on a scratch database or VM):

      rclone copy r2:transitopia-archive/backups/db/transitopia-<date>.dump .
      createdb restore_test && pg_restore -d restore_test transitopia-<date>.dump

- The server's data lives in two Docker volumes: `transitopia_db` (PostgreSQL) and
  `transitopia_var` (recordings, GTFS downloads, build output). The archive bucket holds copies of
  closed recordings and every GTFS feed.
- `.github/workflows/build_transit_data.yml` is now a manual fallback: running it while the server
  publishes replaces the server's build, and live dispatch patches won't fit until the server's
  next build.
