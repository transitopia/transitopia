// The cycling map's published files (packages/cycling-core/README.md#published-files): under
// data/cycling/<area>/, the tiles and the bike routes named by their content, and the index naming
// the current ones, which the site reads first.

/** Where an area's cycling files are published, under the data root: data/cycling/<area>/…. */
export const cyclingDataPath = (area: string, file?: string) =>
  `data/cycling/${area}${file ? `/${file}` : ""}`;

/** The index, beside the files it names: the one cycling file clients poll (cached for 5 minutes). */
export const CYCLING_INDEX = "index.json";

/** index.json: an area's current cycling files. */
export interface CyclingIndex {
  /** The tiles, relative to the index: tiles/<hash>.pmtiles. */
  tiles: string;
  /** The bike routes (`CyclingRoutes`), relative to the index: routes/<hash>.json. */
  routes: string;
  /** The OSM file they were built from (data/osm/<area>/<file>), and when its data is from. */
  osm: { file: string; timestamp: string };
  builtAt: string;
}

/** A bike route: an OSM route relation (`type=route` + `route=bicycle`). */
export interface CyclingRoute {
  name?: string;
  ref?: string;
  /** OSM's `network`: lcn, rcn, ncn or icn (local, regional, national, international). */
  network?: string;
  /** The route relations it contains, by id. */
  subroutes?: number[];
  /** [west, south, east, north] of its ways, and its subroutes'; none when none are in the area. */
  bbox?: [number, number, number, number];
  /** The length of its ways and its subroutes' (each counted once), in metres. */
  lengthM: number;
}

/** routes/<hash>.json: the area's bike routes by relation id (the ids in a path's `routes`). */
export type CyclingRoutes = Record<string, CyclingRoute>;
