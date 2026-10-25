// The transit overview tileset (packages/transit-core/DESIGN.md#overview-tiles): every feed's routes at
// low zoom with static colours, so a zoomed-out map shows every region. Built daily
// (pipelines/build-overview-tiles.ts), drawn by the site (packages/transit-map/src/overview.ts).

import { PLAN_TILES_MIN_ZOOM } from "@transitopia/transit-core/plan/tiles.ts";

/**
 * Bump when the properties the site's layers read change: the file is named by it, so a cached
 * style never reads tiles of another schema. Not for new geometry (that's every day's build).
 */
export const OVERVIEW_TILES_VERSION = 2;

/** The tileset's name: `<name>.pmtiles` locally and in the maps bucket, `<name>.json` from the tile worker. */
export const OVERVIEW_TILES_NAME = `transit-overview-v${OVERVIEW_TILES_VERSION}`;

/** A region's engine starts at this zoom; the overview is drawn only below it. */
export const ENGINE_MIN_ZOOM = PLAN_TILES_MIN_ZOOM;

/**
 * The tileset's layers. Corridors: `tier` (an index into FREQUENCY_BANDS) and, where a route with
 * its own colour runs along it, `color`. Routes: `kind` (PlanRoute.kind), `tier` (its weekday
 * figure's, where it has one) and, for a route with its own colour, `color`: the site draws routes
 * by `tier` when the viewer turns brand colours off. 2: routes with their own colour have `tier`.
 */
export const OVERVIEW_LAYERS = {
  corridors: "corridors",
  routes: "routes",
} as const;
