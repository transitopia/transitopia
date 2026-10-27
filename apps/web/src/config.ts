// Where the site's data comes from. Production values are in .env.production; the defaults here
// are for local development, where vite.config.ts serves the pipelines' output (var/public) at
// /dev-data/.

import { OVERVIEW_TILES_NAME } from "@transitopia/shared/transit-overview.ts";

const env = import.meta.env;

/** Absolute URL for a site-relative path (pmtiles:// and MapLibre glyph URLs must be absolute). */
function absolute(path: string): string {
  return path.startsWith("/") ? `${location.origin}${path}` : path;
}

/** The basemap source: a TileJSON URL, or pmtiles:// for a local extract (npm run tiles -- --region bc). */
export const basemapTiles: string =
  env.VITE_BASEMAP_TILES
  ?? `pmtiles://${absolute("/dev-data/tiles/protomaps-bc.pmtiles")}`;

/** The cycling tiles: a TileJSON URL, or pmtiles:// for a local build (npm run data:cycling). */
export const cyclingTiles: string =
  env.VITE_CYCLING_MAP_TILES_CDN
  ?? `pmtiles://${absolute("/dev-data/tiles/transitopia-cycling-british-columbia.pmtiles")}`;

/** Basemap fonts and sprites (pipelines/tiles.ts), ending in "/". */
export const basemapAssets: string = absolute(
  env.VITE_BASEMAP_ASSETS ?? "/dev-data/basemap-assets/",
);

/** Published transit data (…/data/feeds/<feed>/manifest.json), ending in "/". */
export const transitData: string = env.VITE_TRANSIT_DATA ?? "/dev-data/";

/** The RT service (…/regions/<id>/live/transit), ending in "/"; undefined for schedules only. */
export const transitApi: string | undefined = env.VITE_TRANSIT_API || undefined;

/**
 * Every region's routes zoomed out (packages/transit-core/DESIGN.md#overview-tiles): from the tile
 * worker (a URL ending in "/"), else the local build (npm run build:overview-tiles).
 */
export const transitOverviewTiles: string =
  env.VITE_TRANSIT_OVERVIEW_TILES_CDN ?
    `${env.VITE_TRANSIT_OVERVIEW_TILES_CDN}${OVERVIEW_TILES_NAME}.json`
  : `pmtiles://${absolute(`/dev-data/tiles/${OVERVIEW_TILES_NAME}.pmtiles`)}`;

/** The production site, for canonical URLs: preview builds and local runs point search engines there too. */
export const siteUrl = "https://www.transitopia.org";
