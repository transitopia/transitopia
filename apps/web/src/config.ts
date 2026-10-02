// Where the site's data comes from. Production values are in .env.production; the defaults here
// are for local development, where vite.config.ts serves the pipelines' output (var/public) at
// /dev-data/.

const env = import.meta.env;

/** Absolute URL for a site-relative path (pmtiles:// and MapLibre glyph URLs must be absolute). */
function absolute(path: string): string {
  return path.startsWith("/") ? `${location.origin}${path}` : path;
}

/** The basemap source: a TileJSON URL, or pmtiles:// for a local extract (npm run tiles -- --region bc). */
export const basemapTiles: string =
  env.VITE_BASEMAP_TILES
  ?? `pmtiles://${absolute("/dev-data/tiles/protomaps-bc.pmtiles")}`;

export const cyclingTiles: string =
  env.VITE_CYCLING_MAP_TILES_CDN
  ?? "pmtiles://transitopia-cycling-british-columbia.pmtiles";

/** Basemap fonts and sprites (pipelines/tiles.ts), ending in "/". */
export const basemapAssets: string = absolute(
  env.VITE_BASEMAP_ASSETS ?? "/dev-data/basemap-assets/",
);

/** Published transit data (…/data/manifest.json), ending in "/". */
export const transitData: string = env.VITE_TRANSIT_DATA ?? "/dev-data/";

/** The RT service (…/rt/live), ending in "/"; undefined for schedules only. */
export const transitApi: string | undefined = env.VITE_TRANSIT_API || undefined;

/** Does any tile source need the pmtiles protocol? */
export const needPmTiles = [basemapTiles, cyclingTiles].some((url) =>
  url.startsWith("pmtiles://"),
);
