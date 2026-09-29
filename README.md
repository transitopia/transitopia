# Transitopia

<img src="./apps/web/public/transitopia-logo.svg" alt="Transitopia Logo" height=200>

Transitopia is a mapping project that aims to provide high-quality **public transit**, **cycling**, and **pedestrian** infrastructure maps. The goal is to promote best practices and celebrate high quality infrastructure, while calling attention to unsafe and low-quality infrastructure.

**Current status** (Sep 2026): Online now are **cycling / micromobility maps** for British Columbia. We're building Transitopia V2 ([plan](V2-PLAN.md)), which adds a real-time **transit** map of Metro Vancouver: SkyTrain on the correct track through every switch, SeaBus from live AIS, West Coast Express, and the express buses from GTFS-realtime, with a time slider covering past, live and projected service. The transit engine comes from the skytrain-viz project, merged into this repository with its history.

Online at: **[www.transitopia.org](https://www.transitopia.org/cycling)**.

![Screenshot of www.transitopia.org](./readme-screenshot.png)

## This repository

This repository is a monorepo (npm workspaces) containing most of the parts you need to run and develop Transitopia locally:

* `apps/web`: the Single Page Application that implements the website with the Transitopia map, seen at https://www.transitopia.org/
* `apps/server`: the real-time service: it polls TransLink's GTFS-realtime feeds within a request budget, streams SeaBus AIS positions, records history, and re-dispatches trains live.
* `packages/transit-core`: the DOM-free transit engine: GTFS, the SkyTrain track graph, run inference, a signalling-aware dispatcher, playback, corrections, and bus prediction.
* `packages/transit-map`: the transit map engine (clock, playback, WebGL vehicle layers), with a standalone viewer until it moves into `apps/web`.
* `pipelines`: build-time data pipelines and validators.
* `regions/metro-vancouver`: curated data for Metro Vancouver (config, track infrastructure, scenarios, observations and disruptions).
* `map-layers`: A Transitopia profile for [Planetiler](https://github.com/onthegomap/planetiler) that generates our unique map layers/overlays, like the cycling/micromobility map.

[CLAUDE.md](CLAUDE.md) has more detail on the layout and every command.

## How to run Transitopia locally

You need Node.js 22+ (and optionally Java 21+ if you want to build the maps yourself). Clone this repo, then run `npm install` at its root.

### The cycling map (`apps/web`)

1. Get the vector base map tiles file:
   - Option 1: Download. Go to [Transitopia Base Map Releases](https://github.com/transitopia/planetiler-openmaptiles/releases), find the most recent release, and download `transitopia-base-bc.pmtiles`. Copy it into this repo's `apps/web/public/` folder.
   - Option 2: Build it yourself. Use the [Transitopia planetiler-openmaptiles](https://github.com/transitopia/planetiler-openmaptiles) repository to generate the `transitopia-base-bc.pmtiles` vector map data file using planetiler (see that repo's README). Copy the resulting map data file into this repo: `cp ../planetiler-openmaptiles/data/transitopia-base-bc.pmtiles apps/web/public/transitopia-base-bc.pmtiles`.
2. Get the vector overlay tiles file: this contains the cycling paths, pedestrian paths, etc. and is specific to Transitopia.
   - Option 1: Download. Go to [this page](https://github.com/transitopia/transitopia/actions/workflows/build_cycling.yml?query=event%3Aschedule), select the latest run, then click on `compiled-maps` to download the .zip file with the vector overlays. Unzip it, then copy `transitopia-cycling-british-columbia.pmtiles` into this repo's `apps/web/public/` folder.
   - Option 2: Build it yourself. Use the `map-layers` folder in this repository to generate the `transitopia-cycling-british-columbia.pmtiles` vector map data file using planetiler. See [the README](./map-layers/README.md) for instructions.
3. Run the development server: `npm run dev`
4. Go to http://localhost:5174/ in your browser.

### The transit map (standalone viewer)

```sh
npm run tiles           # build the Metro Vancouver PMTiles basemap (one-time)
npm run data:gtfs       # fetch the latest GTFS feed and build the timetable data
npm run build:infra     # publish the track network and platform mapping
npm run build:movements # infer train runs and dispatch them, per day type
npm run dev:transit     # viewer at http://localhost:5173, plus the local RT service
```

Downloads and build output go to `var/` (gitignored). The track network itself is committed (`regions/metro-vancouver/infrastructure/`), and `npm run data:osm` re-imports it from OpenStreetMap.

Without TransLink and aisstream.io API keys, everything runs in schedule-only (*estimated*) mode, which is what development normally uses: TransLink allows 1,000 requests a day per key, and one poller spends them for production (see [V2-PLAN.md §4.5 and §7.5](V2-PLAN.md)).

## Credits

Transitopia is a project by [Braden MacDonald](https://www.bradenmacdonald.com) ([@bradenmacdonald](https://github.com/bradenmacdonald) on GitHub).

All source code is open source and all data is open data, but the licenses vary.

The primary source of map data is [OpenStreetMap](https://www.openstreetmap.org/). Vector map tiles are generated using [planetiler](https://github.com/onthegomap/planetiler) - see the `map-layers` folder for all the details on how the map is generated.

The map is rendered using [MapLibre GL](https://maplibre.org/).

Transit data: TransLink GTFS static and GTFS-realtime ([app developer resources](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-realtime)). Some of the data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service. SkyTrain track topology is cross-checked against the [Vancouver SkyTrain track diagram v3](https://commons.wikimedia.org/wiki/File:Vancouver_SkyTrain_track_diagram_v3.svg) (Wikimedia Commons). The transit map's basemap is built with [Protomaps](https://protomaps.com/). This is not an official TransLink product, and train positions are estimates.

Map vector tile data is stored in the [PMTiles](https://github.com/protomaps/PMTiles) format.

The base map style is a customized version of [OpenMapTiles Positron](https://github.com/openmaptiles/positron-gl-style), and the base map is [a customized version of OpenMapTiles](https://github.com/transitopia/planetiler-openmaptiles).

Hosting is provided by [Cloudflare Workers](https://workers.cloudflare.com/).
