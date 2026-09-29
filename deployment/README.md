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

    rclone copy var/public/tiles/protomaps-bc.pmtiles transitopia-maps-r2:transitopia-maps --s3-no-check-bucket

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

The server (`apps/server`, V2-PLAN.md §4.3, §7) runs on a FullHost VM in Vancouver with Docker
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

#### One-time setup

1. **VM** (FullHost, Vancouver): Ubuntu 24.04 LTS or Debian 13, about 4 vCPU, 8 GB RAM, 160 GB
   SSD. Install Docker Engine with the Compose plugin. Create a `deploy` user in the `docker` group
   with SSH key login. Open ports 22, 80 and 443 (443 can be limited to Cloudflare's IP ranges).
2. **Object storage** (FullHost, S3-compatible): a private bucket, e.g. `transitopia-archive`, and
   an access key for it. Check it works with rclone before relying on it (V2-PLAN.md §11):
   `rclone mkdir fullhost:transitopia-archive/test && rclone copy README.md fullhost:transitopia-archive/test && rclone ls fullhost:transitopia-archive`.
3. **R2 token** that can write the `transitopia-data` bucket (the one in the GitHub secrets will
   do, or a new one), for publishing the transit data.
4. **GitHub OAuth app** (github.com → Settings → Developer settings → OAuth Apps, under the
   `transitopia` organisation): homepage `https://www.transitopia.org`, callback
   `https://api.transitopia.org/auth/github/callback`. Note the client ID and a client secret.
5. **Cloudflare** (transitopia.org zone):
   - DNS: `api` → the VM's IP, proxied (orange cloud).
   - SSL/TLS: mode **Full (strict)**. SSL/TLS → Origin Server → Create certificate for
     `api.transitopia.org` (15 years). Save the certificate and key on the VM as
     `/opt/transitopia/infra/certs/origin.pem` and `origin.key` (`chmod 600`).
   - Caching → Cache Rules: when hostname is `api.transitopia.org` and URI path starts with `/rt/`:
     eligible for cache, edge TTL "use cache-control header if present, bypass cache if not".
     (`/rt/live` says 10 s, closed history hours a day, dispatch versions a year; Cloudflare doesn't
     cache JSON without a rule.) Nothing else on `api.` is cached (`/healthz`, `/admin`, `/auth`).
   - Optional: a rate-limiting rule for `api.transitopia.org`.
6. **On the VM**, as `deploy`:

       sudo mkdir -p /opt/transitopia && sudo chown deploy: /opt/transitopia
       git clone https://github.com/transitopia/transitopia.git /opt/transitopia
       cd /opt/transitopia && git checkout v2        # prod, once it has Phase 2
       cp infra/.env.example infra/.env && cp infra/rclone.conf.example infra/rclone.conf
       chmod 600 infra/.env infra/rclone.conf

   Fill in `infra/.env` (a long random `POSTGRES_PASSWORD`, `TRANSLINK_API_KEY`,
   `AISSTREAM_API_KEY`, the GitHub app, `ADMIN_GITHUB_LOGINS`) and `infra/rclone.conf` (R2 and
   FullHost endpoints and keys). The remote names must match `DATA_PUBLISH_REMOTE` and
   `ARCHIVE_REMOTE` in `.env`.

#### First start

**Stop every other process polling with the same TransLink key first** (e.g. a local
`npm run server` with `.secrets`): the 1,000 requests a day are per key. Since Phase 2 a local
server doesn't poll unless `RT_POLL=1`.

1. Copy the local history (and the GTFS feeds it was recorded against) to the VM, from your
   machine:

       cd var && rsync -aR rt-history ais-history dispatch-history raw/gtfs deploy@<vm>:history/

2. Build the images and start the database:

       cd /opt/transitopia
       docker compose -f infra/compose.yml build
       docker compose -f infra/compose.yml up -d db

3. Import the history into the server's volume and the database (idempotent; about a minute for a
   few days):

       docker compose -f infra/compose.yml run --rm -v ~/history:/import:ro server \
         sh -c 'cp -r /import/. var/ && npm run db:import-history'

4. Start everything:

       docker compose -f infra/compose.yml up -d
       docker compose -f infra/compose.yml logs -f server

   On first start the server applies the migrations, imports the committed corrections, starts
   polling, and builds and publishes the transit data (a couple of minutes; it replaces what's on
   `data.transitopia.org` with the same build from this commit).

5. Check:

       curl https://api.transitopia.org/healthz          # {"ok":true,…}
       curl https://api.transitopia.org/rt/status        # leader: true, budget.used24h counting up
       curl -sI https://api.transitopia.org/rt/live      # cf-cache-status: HIT within 10 s of a MISS

   Sign in at https://www.transitopia.org/admin once the site is deployed (below), or from a
   local `npm run dev` with `VITE_TRANSIT_API=https://api.transitopia.org/` (localhost:5173 is in
   `ALLOWED_ORIGINS`).

6. Run a backup now and look at the bucket:

       docker compose -f infra/compose.yml run --rm backup /usr/local/bin/backup.sh --now
       rclone ls fullhost:transitopia-archive/backups

7. Deploy the site: merge `v2` into `prod` and push. `apps/web/.env.production` now sets
   `VITE_TRANSIT_API=https://api.transitopia.org/`, so buses go live on transitopia.org.

#### Monitoring

`/healthz` returns 503 when positions polls or AIS go stale, the database is unreachable, or a
daily job (statistics, data build, backup) failed or hasn't succeeded for 36 hours. Point an
uptime monitor at `https://api.transitopia.org/healthz` (e.g. UptimeRobot or Better Stack, every
5 minutes, alert on anything but 200). The response body says which check failed; `/admin` shows
the same, plus recent jobs.

#### Automatic deploys

`.github/workflows/deploy_server.yml` builds the server image on every push to `prod` that touches
the server's code, pushes it to `ghcr.io/transitopia/transitopia-server`, and, once these
repository secrets exist, restarts it on the VM:

- `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (a private key whose public half is in
  the deploy user's `authorized_keys`), `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan <vm>`).

The GHCR package is private by default: either make it public (it contains no secrets), or run
`docker login ghcr.io` on the VM with a token that can read packages. Migrations run when the
server starts. After changing `infra/backup/`, rebuild it on the VM:
`docker compose -f infra/compose.yml up -d --build backup`.

#### Operations

- Logs: `docker compose -f infra/compose.yml logs -f server` (or `db`, `caddy`, `backup`).
- A psql shell: `docker compose -f infra/compose.yml exec db psql -U transitopia`.
- Recompute a date's statistics: `docker compose -f infra/compose.yml exec server npm run stats -- 20261001`.
- Restore a backup (test quarterly, V2-PLAN.md §7.3, on a scratch database or VM):

      rclone copy fullhost:transitopia-archive/backups/db/transitopia-<date>.dump .
      createdb restore_test && pg_restore -d restore_test transitopia-<date>.dump

- The server's data lives in two Docker volumes: `transitopia_db` (PostgreSQL) and
  `transitopia_var` (recordings, GTFS downloads, build output). The archive bucket holds copies of
  closed recordings and every GTFS feed.
- `.github/workflows/build_transit_data.yml` is now a manual fallback: running it while the server
  publishes replaces the server's build, and live dispatch patches won't fit until the server's
  next build.
