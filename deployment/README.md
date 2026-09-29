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
| `transitopia-base-bc.pmtiles` | Retired in V2 (the OpenMapTiles basemap); delete once V2 is live. |

The worker's `ALLOWED_ORIGINS` variable lists the sites allowed to use the tiles (CORS), comma
separated. It keeps other websites from building maps on our tiles and using up our Cloudflare
allowance. It doesn't stop non-browser clients. Entries may use `*` for one subdomain label, which
is a Transitopia change to the upstream worker:

    https://www.transitopia.org,https://transitopia.org,https://*.transitopia-web.pages.dev,https://transitopia-web.pages.dev,http://localhost:5173

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

One-time setup (not done yet):

1. Create the R2 bucket `transitopia-data` and connect the custom domain `data.transitopia.org`.
2. Add a CORS policy allowing `GET` and `HEAD` from `https://www.transitopia.org` (and
   `https://transitopia.org`).
3. Cache: `data/manifest.json` should be short-lived (e.g. 5 minutes); everything else can be cached
   for longer. (Content-hashed paths are planned, V2-PLAN.md §5.2.)
4. Add GitHub secrets `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_ACCESS_KEY_ID` and
   `RCLONE_CONFIG_TRANSITOPIA_DATA_R2_SECRET_ACCESS_KEY` (an R2 API token that can write the bucket;
   the endpoint is shared with the maps bucket).

### The website (www.transitopia.org)

A static build of `apps/web` on Cloudflare. Since V2 the app lives in `apps/web` (it was `web-ui/`)
and the repo is an npm workspace, so the Cloudflare build settings need:

- Root directory: the repository root
- Build command: `npm ci && npm run build -w @transitopia/web`
- Output directory: `apps/web/dist`
- `CF_WEB_ANALYTICS_TOKEN`: the Cloudflare Web Analytics site token (optional; V2-PLAN.md §7.6).
  Alternatively, turn on Web Analytics in the Cloudflare dashboard, which injects the beacon itself.

Production data locations are in `apps/web/.env.production`.
