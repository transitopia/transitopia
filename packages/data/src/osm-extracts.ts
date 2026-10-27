// Downloaded OSM extracts (pipelines/fetch-osm-extract.ts): var/raw/osm-extracts/<area>/YYYY-MM-DD.osm.pbf,
// named by the date of their data.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cyclingPaths } from "./paths.ts";

const EXTRACT = /^(\d{4}-\d{2}-\d{2})\.osm\.pbf$/;

/** An area's extracts, newest first. */
export async function listExtracts(
  area: string,
): Promise<{ date: string; path: string }[]> {
  const dir = cyclingPaths(area).extracts;
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .map((f) => EXTRACT.exec(f)?.[1])
    .filter((d) => d !== undefined)
    .sort()
    .reverse()
    .map((date) => ({ date, path: join(dir, `${date}.osm.pbf`) }));
}
