# @transitopia/cycling-core

The cycling map's logic, DOM-free and shared by the pipeline that builds the cycling tiles and the site that draws them: reading OSM, classifying cycling facilities, joining ways into chains, and the tiles' schema. Settings are in [config/cycling/cycling.json](../../config/cycling/cycling.json) (schema in `packages/transit-core/src/config.ts`).

| File | What |
|---|---|
| `src/osm.ts` | OSM elements, and `parseOpl` for osmium's OPL text |
| `src/classify.ts` | `classifyWay`: a way's facility and comfort; `OSM_FILTERS`: what to keep from an extract |
| `src/network.ts` | `CyclingNetworkBuilder`: OSM elements in, classified ways (with their bike routes), bike parking and bike routes out |
| `src/chains.ts` | `joinChains`: ways joined into chains |
| `src/tiles.ts` | The tiles' layer, zooms, properties (`CyclingWayProperties`, `BikeParkingProperties`) and `cyclingTileFeatures` |
| `src/lookup.ts` | `cyclingLookup` and `findCyclingFeature`: OSM refs → where they are, for the feature resolver ([Lookup](#lookup)) |
| `src/published.ts` | Where the [published files](#published-files) are, the index (`CyclingIndex`) and the bike routes (`CyclingRoutes`) |

## Building the tiles

In two parts, so that only the first needs osmium, the 1.3 GB extract and 2.5 GB of memory, and it runs in GitHub Actions; the server's daily data build (`npm run data`, [apps/server → Jobs](../../apps/server/README.md#jobs)) does the second and publishes the result:

1. **The cycling OSM file** (`npm run extract:cycling-osm`, `pipelines/extract-cycling-osm.ts`; GitHub Actions runs it daily, `.github/workflows/build_cycling.yml`):
   - **Download** Geofabrik's daily extract of British Columbia (`area.extract`, about 1.3 GB), checked against its `.md5`, into `var/raw/osm-extracts/<area>/YYYY-MM-DD.osm.pbf`, named by the date of its data (from its header); only the newest is kept. `--extract <file.osm.pbf>` uses one already on disk instead.
   - **Filter** with osmium: `osmium tags-filter` keeps the ways, nodes and relations with a tag in `OSM_FILTERS` (and what they reference), then `osmium add-locations-to-ways` writes them as OPL with each way's node locations (about 80 MB), gzipped to `var/raw/osm-cycling/<area>/<date>-<sha256 prefix>.opl.gz` (about 20 MB for BC), with `latest.json` (`CyclingOsmPointer`: the file, the OSM data's timestamp, its size and sha256) beside it.
   - The filter's peak memory is about 2.5 GB whatever the area (it tracks referenced objects in bitmaps over the whole range of OSM ids): 2.46 GB for BC, 2.48 GB for all of Canada, measured 2026-10-27.
   - The workflow publishes the file and its pointer at `https://data.transitopia.org/data/osm/<area>/` (the file cached for good, since its name changes with its content; the pointer for 5 minutes; files over two weeks old removed), and keeps them as the run's `cycling-osm` artifact for two weeks.
2. **The tiles and bike routes** (`npm run data:cycling`: `pipelines/fetch-cycling-osm.ts`, then `pipelines/build-cycling.ts`, which is `npm run build:cycling`; `npm run data` runs both, and the build goes on without them if they fail):
   - **Fetch** the published file into `var/raw/osm-cycling/<area>/`, unless it's there already, checked against the pointer's sha256 (`CYCLING_OSM_FROM` names another data root).
   - **Classify** each way, keep bike parking, and note each way's bike route relations and every bike route's ways (`CyclingNetworkBuilder`), reading the gzipped OPL as it streams: 0.6 GB of memory for BC, 1.4 GB for Canada.
   - **Tile** with tippecanoe: `cyclingTileFeatures`. Nothing is dropped to fit tile limits; features with the same attributes and no id are coalesced.
   - **Write** the [published files](#published-files) to `var/public/data/cycling/<area>/` (served locally at `/dev-data/data/cycling/<area>/`), removing those the new index doesn't name, and the [lookup](#lookup) to `var/cycling/<area>/lookup.json` before the index.

The tiles take a few seconds to build from the OSM file, and need tippecanoe 2.17 or later (`TIPPECANOE` names it when it isn't on the PATH); the OSM file takes about 30 s more, plus the download, and needs osmium-tool (`brew install osmium-tool`, `apt install osmium-tool`; `OSMIUM`). The workflow builds the tiles too, as a check, but doesn't publish them.

`OSM_FILTERS` runs in the workflow, before classification, so a rule that reads a new tag needs the filters to keep it (`test/filters.test.ts` checks a way for each rule); the published file has it from the workflow's next run (or run the workflow by hand, or `npm run extract:cycling-osm` locally).

## Classification

`classifyWay` decides what a way is, from its tags, by the first of these rules that matches. Ported rule for rule from the Planetiler profile this replaced, so the map stayed the same (verified on the same extract: every attribute equal at z14, with a tile inspector kept on the `cycling-tile-inspector` branch).

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

"Calm" is `maxspeed` at or under `classify.calmMaxSpeedKmh` (`maxspeedKmh`): a number in km/h or mph, `walk`, or the fastest of several. Implied limits such as `CA:urban`, and words such as `none`, aren't calm. (The Planetiler profile read any value that didn't start with a number as 0, so `CA:urban` counted as calm.) Two quirks are kept from the original: `cycleway:both=shared_lane` matches without a `highway` tag, and parking mapped as separate ways (`parking:*=separate`) counts as parked cars beside the lane without looking at those ways.

A way is a line unless it's closed and `area=yes`, and is left out if any of its nodes has no location. Bike parking is a node, or the centre of a closed way (`area` other than `no`); bike parking mapped as a multipolygon relation isn't drawn (there are none in BC). A way's `routes` are the bike route relations (`type=route` + `route=bicycle`) it's a direct member of: a route that contains another route doesn't name its subroute's ways.

## Chains

The tiles don't carry OSM ways one by one: `joinChains` joins consecutive ways with the same attributes into a chain, broken wherever more than two cycling ways meet (a way passing through a node counts as two ends there). One-way chains (`oneway` 1 or -1) only join head to tail, keeping their direction, since the map draws arrows along them; the others are turned around as needed. A chain is the same in every tile, so the map highlights and selects a whole chain, not a tile's piece of it.

## Tiles

One layer, `transitopia_cycling`, zooms 6–14:

| Zooms | Features | Id | Properties |
|---|---|---|---|
| 13–14 | Paths and lanes: chains of ways with every property | `osmFeatureId("way", <the chain's lowest way id>)` | `CyclingWayProperties`: the classification, plus `name`, `surface`, `routes` (relation ids, ascending, comma-separated) |
| 6–12 | Paths and lanes, joined by what's drawn | none | The classification only |
| 12–14 | Bike parking | `osmFeatureId("node"\|"way", …)` | `BikeParkingProperties`: `amenity`, `name`, its details (`bicycle_parking`, `capacity`, `covered`, `indoor`, `operator`), `osmNodeId` or `osmWayId` |

- **Ids** are `id × 10 + 1, 2 or 3` for a node, way or relation, so a path's and a bike rack's never collide. Below z13 there's nothing to select, so there are no ids, and tippecanoe coalesces lines with the same properties in a tile.
- **The widest views aren't crumbs, and paths don't break up**: below z13 the ways are joined into chains by what's drawn, and a chain shows from the zoom at which its group (the chains with the same properties connected to it) is at least a pixel long (`MIN_PX`). A long path made of short ways or broken by junctions shows whole, and only short, isolated pieces wait for closer zooms. (The Planetiler profile dropped each way under a pixel long, which left gaps in long paths made of short ways.)
- **Bike parking carries its details**, so the site's card needs nothing from the OSM API ([docs/DESIGN.md](../../docs/DESIGN.md), principle 3). They're small: 65 KB on BC's 5.3 MB of tiles (7,373 bike parking, measured 2026-10-27), so they're at every zoom bike parking shows. `capacity` is kept only where it's a plain number, and `covered` and `indoor` are true for any value but `no` (`partial`, `room`, …).
- **A path's OSM ways aren't in the tiles**, only its first by id (in its id). A link naming another of its ways goes through the [lookup](#lookup), which gives the first. Carrying every way id would have added 0.8 MB to BC's tiles (5.4 → 6.2 MB, measured 2026-10-29) for links the site doesn't write.
- The site's styles (`apps/web/src/CyclingMap/cycling-map-layers.ts`) filter on `comfort`, `class`, `construction` and `oneway`, and its cards (`BikeRouteCard`, `BikeParkingCard`) read the other properties.

## Published files

The server's data build publishes them with the transit data at `https://data.transitopia.org/data/cycling/<area>/` ([deployment → Transit data](../../deployment/README.md#transit-data-datatransitopiaorg)), and the site reads them from there (`apps/web/src/CyclingMap/cycling-data.ts`):

| File | What | Cached |
|---|---|---|
| `index.json` | `CyclingIndex`: the current tiles and bike routes (paths relative to it), the OSM file they're from and its timestamp, and when they were built | 5 minutes, and uploaded after the files it names |
| `tiles/<hash>.pmtiles` | The [tiles](#tiles), read by range requests through the pmtiles protocol | a day |
| `routes/<hash>.json` | `CyclingRoutes`: each bike route by relation id (the ids in a path's `routes`), with its `name`, `ref`, `network` (`lcn`, `rcn`, `ncn`, `icn`), `subroutes` (the bike routes it contains), `bbox` and `lengthM` | a day |

- **Named by their content**, so a name always means the same file and a client holding an older index still finds what it names. The tiles' hash is of their input (the features as tippecanoe reads them, and `TILES_FORMAT` in `pipelines/build-cycling.ts`): tippecanoe's output differs from one run to the next, since its metadata names its temporary input file. Files the index no longer names are deleted from the bucket after two weeks.
- **A route's `bbox` and `lengthM`** are of its ways and its subroutes', each way counted once (a route with a way per direction counts both), and only the ways in the area: the ways a route relation names come with it in the OSM file, whether or not they're cycling facilities. A route none of whose ways are in the area has no `bbox`. BC has 964 bike routes, 120 KB.
- **Nothing here needs a feature ID** (issue #229, phase 5): routes are keyed by their OSM relation id.

## Lookup

The feature resolver ([apps/server → Feature resolver](../../apps/server/README.md#feature-resolver)) answers OSM refs from the latest build, so a link to a path or bike parking works without the map's position and without calling OSM. `build-cycling` writes `var/cycling/<area>/lookup.json` (`CyclingLookup`, not published: 2.9 MB for BC): each detail chain's first way by id, bbox and name, each OSM way's chain, and each bike parking's position and name by ref. `findCyclingFeature` reads it, and the bike routes file for `osm-relation:` refs. Its answer's `key` is how the tiles know the feature: for a path, `osm-way:<its first way>`, whichever of its ways was asked for, so a link stays good when an edit regroups the ways into chains (the way it names must still be a cycling way).
