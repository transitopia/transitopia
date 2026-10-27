# @transitopia/cycling-core

The cycling map's logic, DOM-free and shared by the pipeline that builds the cycling tiles and the site that draws them: reading OSM, classifying cycling facilities, joining ways into chains, and the tiles' schema. Settings are in [config/cycling/cycling.json](../../config/cycling/cycling.json) (schema in `packages/transit-core/src/config.ts`).

| File | What |
|---|---|
| `src/osm.ts` | OSM elements, and `parseOpl` for osmium's OPL text |
| `src/classify.ts` | `classifyWay`: a way's facility and comfort; `OSM_FILTERS`: what to keep from an extract |
| `src/network.ts` | `CyclingNetworkBuilder`: OSM elements in, classified ways (with their bike routes) and bike parking out |
| `src/chains.ts` | `joinChains`: ways joined into chains |
| `src/tiles.ts` | The tiles' layer, zooms, properties (`CyclingWayProperties`, `BikeParkingProperties`) and `cyclingTileFeatures` |

## Building the tiles

`npm run data:cycling` (`pipelines/fetch-osm-extract.ts`, then `pipelines/build-cycling.ts`):

1. **Download** Geofabrik's daily extract of British Columbia (`area.extract`, about 1.3 GB), checked against its `.md5`, into `var/raw/osm-extracts/<area>/YYYY-MM-DD.osm.pbf`, named by the date of its data (from its header). The newest two are kept; `--max-age-days 1` skips the download when the newest is recent.
2. **Filter** with osmium: `osmium tags-filter` keeps the ways, nodes and relations with a tag in `OSM_FILTERS` (and what they reference), then `osmium add-locations-to-ways` writes them as OPL with each way's node locations, about 80 MB. The filter's peak memory is about 2.5 GB for BC.
3. **Classify** each way, keep bike parking, and note each way's bike route relations (`CyclingNetworkBuilder`).
4. **Tile** with tippecanoe: `cyclingTileFeatures`, then `var/public/tiles/transitopia-cycling-<area>.pmtiles`, served locally at `/dev-data/tiles/`. Nothing is dropped to fit tile limits; features with the same attributes and no id are coalesced.

The whole build takes under a minute on a laptop, most of it in osmium. It needs osmium-tool (`brew install osmium-tool`, `apt install osmium-tool`) and tippecanoe 2.17 or later; `OSMIUM` and `TIPPECANOE` name them when they aren't on the PATH. GitHub Actions builds and publishes it daily (`.github/workflows/build_cycling.yml`, [deployment → Map tiles](../../deployment/README.md#map-tiles-map-tilestransitopiaorg)).

`npx tsx pipelines/inspect-cycling-tiles.ts <a.pmtiles> [--compare <b.pmtiles>]` shows what a tileset holds per zoom (tiles, bytes, features, km of line by attribute value) and, with `--compare`, matches the first's lines at the highest zoom to the second's and totals every attribute that differs, with an example place. Run it after changing the classification or the tiles, against tiles built from the same extract before the change.

## Classification

`classifyWay` decides what a way is, from its tags, by the first of these rules that matches. Ported rule for rule from the Planetiler profile this replaced, so the map stayed the same (verified with `inspect-cycling-tiles` on the same extract: every attribute equal at z14).

| Rule | `class` | `comfort` |
|---|---|---|
| `highway=cycleway` | track (`subclass` cycleway) | 4, or 3 shared with pedestrians (`foot=designated` + `segregated=no`) |
| `highway=path\|pedestrian` + `bicycle=designated` | track (path) | 4, or 3 shared with pedestrians |
| any `highway` + `cycleway=track` | track (`combined-<highway>`) | 4, or 3 shared with pedestrians |
| `highway=construction` + `construction=cycleway` | track, `construction`, with `website` and `opening_date` | as above |
| a lane on both sides of a two-way road (`cycleway=lane`, `cycleway:both=lane`, or both sides) | lane, `side` both | 2, or 1 with parked cars beside it (`dooring_risk`) |
| a two-way lane on one side of a two-way road (`cycleway:<side>:oneway=no`) | lane | 2 |
| a lane on a one-way road | lane, one-way unless both sides | 2, or 1 with `parking:<side>` |
| a shared lane (`cycleway=shared_lane\|shared`, or `cycleway:both`) | lane, `shared_with_vehicles` | 3 if `motor_vehicle=private` or calm, else 1 |
| `highway=residential` + `bicycle=yes\|designated`, calm | lane, `shared_with_vehicles` | 3 |
| a one-way lane on one side of a two-way road (the other side `no`) | lane, `oneway` 1 (right) or -1 (left) | 2, or 1 with parked cars |

"Calm" is `maxspeed` at or under `classify.calmMaxSpeedKmh`, read as Planetiler read numbers (`planetilerLong`): the number a value starts with, and 0 for one that doesn't start with a number (`CA:urban` counts as calm). Two quirks are kept from the original: `cycleway:both=shared_lane` matches without a `highway` tag, and parking mapped as separate ways (`parking:*=separate`) counts as parked cars beside the lane without looking at those ways.

A way is a line unless it's closed and `area=yes`, and is left out if any of its nodes has no location. Bike parking is a node, or the centre of a closed way (`area` other than `no`); bike parking mapped as a multipolygon relation isn't drawn (there are none in BC). A way's `routes` are the bike route relations (`type=route` + `route=bicycle`) it's a direct member of: a route that contains another route doesn't name its subroute's ways.

## Chains

The tiles don't carry OSM ways one by one: `joinChains` joins consecutive ways with the same attributes into a chain, broken wherever more than two cycling ways meet (a way passing through a node counts as two ends there). One-way chains (`oneway` 1 or -1) only join head to tail, keeping their direction, since the map draws arrows along them; the others are turned around as needed. A chain is the same in every tile, so the map highlights and selects a whole chain, not a tile's piece of it.

## Tiles

One layer, `transitopia_cycling`, zooms 6–14:

| Zooms | Features | Id | Properties |
|---|---|---|---|
| 13–14 | Paths and lanes: chains of ways with every property | `osmFeatureId("way", <the chain's lowest way id>)` | `CyclingWayProperties`: the classification, plus `name`, `surface`, `routes` (relation ids, ascending, comma-separated) |
| 6–12 | Paths and lanes, joined by what's drawn | none | The classification only |
| 12–14 | Bike parking | `osmFeatureId("node"\|"way", …)` | `amenity`, `name`, `osmNodeId` or `osmWayId` |

- **Ids** are `id × 10 + 1, 2 or 3` for a node, way or relation, so a path's and a bike rack's never collide. Below z13 there's nothing to select, so there are no ids, and tippecanoe coalesces lines with the same properties in a tile.
- **The widest views aren't crumbs**: below z13 a way is drawn only from the zoom at which it's at least a pixel long (`MIN_WAY_PX`), as the Planetiler profile drew them, and the ways seen at each zoom are joined into chains of their own.
- The site's styles (`apps/web/src/CyclingMap/cycling-map-layers.ts`) filter on `comfort`, `class`, `construction` and `oneway`, and its cards (`BikeRouteCard`, `BikeParkingCard`) read the other properties.
