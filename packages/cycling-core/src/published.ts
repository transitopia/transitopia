// The cycling map's published files (packages/cycling-core/README.md#published-files): under
// data/cycling/<area>/, the tiles named by their content, and the index naming the current ones,
// which the site reads first.

/** Where an area's cycling files are published, under the data root: data/cycling/<area>/…. */
export const cyclingDataPath = (area: string, file?: string) =>
  `data/cycling/${area}${file ? `/${file}` : ""}`;

/** The index, beside the files it names: the one cycling file clients poll (cached for 5 minutes). */
export const CYCLING_INDEX = "index.json";

/** index.json: an area's current cycling files. */
export interface CyclingIndex {
  /** The tiles, relative to the index: tiles/<hash>.pmtiles. */
  tiles: string;
  /** The OSM file they were built from (data/osm/<area>/<file>), and when its data is from. */
  osm: { file: string; timestamp: string };
  builtAt: string;
}
