// OSM data for the cycling map (packages/cycling-core/README.md#building-the-tiles). Geofabrik's
// extracts, downloaded where osmium runs (var/raw/osm-extracts/<area>/YYYY-MM-DD.osm.pbf, named by
// the date of their data), and what osmium keeps of them for the cycling map: an OPL file with way
// node locations, gzipped, and a pointer to the newest (var/raw/osm-cycling/<area>/:
// <date>-<first 8 of its sha256>.opl.gz, so a name always means the same bytes, and latest.json). GitHub Actions publishes those at data/osm/<area>/ for everyone else.

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cyclingPaths, writeJson } from "./paths.ts";

const EXTRACT = /^(\d{4}-\d{2}-\d{2})\.osm\.pbf$/;
const CYCLING_OSM = /^(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}\.opl\.gz$/;

/** The pointer to the newest cycling OSM file, beside it. */
export const CYCLING_OSM_POINTER = "latest.json";

/** Where the cycling OSM files are published, under the data root's parent: data/osm/<area>/. */
export const cyclingOsmDataPath = (area: string) => `data/osm/${area}`;

/** Where they're fetched from by default: production's published data (CYCLING_OSM_FROM overrides it). */
export const CYCLING_OSM_FROM =
  process.env.CYCLING_OSM_FROM ?? "https://data.transitopia.org/";

/** latest.json: the newest cycling OSM file in its directory. */
export interface CyclingOsmPointer {
  /** Its file name, beside the pointer: <date>-<sha256 prefix>.opl.gz. */
  file: string;
  /** When its OSM data is from (the extract's replication timestamp). */
  osmTimestamp: string;
  /** The extract it was made from. */
  extract: string;
  bytes: number;
  sha256: string;
  generatedAt: string;
}

/** Files in `dir` matching `re`, newest first by the date in their name. */
async function dated(
  dir: string,
  re: RegExp,
): Promise<{ date: string; path: string }[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .flatMap((f) => {
      const date = re.exec(f)?.[1];
      return date ? [{ date, path: join(dir, f) }] : [];
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** An area's downloaded extracts, newest first. */
export async function listExtracts(
  area: string,
): Promise<{ date: string; path: string }[]> {
  return dated(cyclingPaths(area).extracts, EXTRACT);
}

/** Delete all but the newest `keep` extracts of an area. */
export async function pruneExtracts(area: string, keep: number) {
  for (const old of (await listExtracts(area)).slice(keep))
    await rm(old.path, { force: true });
}

/** The newest cycling OSM file in `dir`, from its pointer; undefined if there's none. */
export async function readCyclingOsm(
  dir: string,
): Promise<{ pointer: CyclingOsmPointer; path: string } | undefined> {
  const raw = await readFile(join(dir, CYCLING_OSM_POINTER), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return undefined;
  const pointer = JSON.parse(raw) as CyclingOsmPointer;
  return { pointer, path: join(dir, pointer.file) };
}

/** Point `dir`'s latest.json at a file in it, and delete all but the newest `keep` files. */
export async function writeCyclingOsmPointer(
  dir: string,
  pointer: CyclingOsmPointer,
  keep: number,
): Promise<void> {
  await writeJson(join(dir, CYCLING_OSM_POINTER), pointer, true);
  for (const old of (await dated(dir, CYCLING_OSM)).slice(keep))
    if (old.path !== join(dir, pointer.file))
      await rm(old.path, { force: true });
}
