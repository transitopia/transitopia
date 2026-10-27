# @transitopia/data

Node-side access to the region's data on disk, used by both the [pipelines](../../pipelines/README.md) and the [server](../../apps/server/README.md). Runtime code the server needs lives here rather than in `pipelines/`, so the server doesn't depend on the build scripts. Not for the browser: it reads files.

- `src/paths.ts`: the one place that knows where data lives (`config/`, `var/`, the published data under `var/public/`: `feedPaths`, `regionDataDir`), plus JSON helpers and the checked readers `readConfig` (a region config file), `readRegion(s)`, `readFeed(s)`, `readFeedRoutes` and `readManifest`. `regionPaths(region)` gives a region's files, `cyclingPaths(area)` and `readCyclingConfig()` the cycling map's, `readFeedConfig` a feed's settings resolved in layers, and `railNetworks()` / `railNetwork()` the feeds with track-level rail and their regions.
- `src/gtfs-zip.ts`, `src/gtfs-day.ts`: reading GTFS zips, and the archived feeds and one service day's trips and stops from them.
- `src/disruptions.ts`: the disruption files and the service dates each one touches.
- `src/infra.ts`: the track graph, platform mapping and overrides as published.
- `src/osm-extracts.ts`, `src/osmium.ts`: downloaded OSM extracts by date and the cycling OSM files made from them (with their `latest.json` pointer), and running osmium-tool ([cycling-core → Building the tiles](../cycling-core/README.md#building-the-tiles)).
- `src/plan-tiles.ts`: tippecanoe, for plan, overview and cycling tiles; `src/pmtiles-file.ts`: reading every tile of a local PMTiles file.
- `src/dispatch-context.ts`, `src/dispatch-debug.ts`: what dispatching a date needs (plan, graph, movements, config), cached per feed, and the `DISPATCH_*` debug settings from the environment ([transit-core → Dispatcher](../transit-core/DESIGN.md#dispatcher)).
