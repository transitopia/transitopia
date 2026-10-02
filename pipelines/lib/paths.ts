import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Committed, curated inputs for the region (config, infrastructure, scenarios, corrections).
export const REGION_DIR = join(ROOT, "regions", "metro-vancouver");
export const CONFIG_DIR = join(REGION_DIR, "config");
export const INFRA_DIR = join(REGION_DIR, "infrastructure");
export const SCENARIOS_DIR = join(REGION_DIR, "scenarios");
// Corrections: the committed files, or on the server an export of the confirmed ones from its
// database (TRANSITOPIA_CORRECTIONS_DIR, with observations/ and disruptions/ inside).
const CORRECTIONS_DIR = process.env.TRANSITOPIA_CORRECTIONS_DIR;
export const OBSERVATIONS_DIR =
  CORRECTIONS_DIR ?
    join(CORRECTIONS_DIR, "observations")
  : join(REGION_DIR, "observations");
export const DISRUPTIONS_DIR =
  CORRECTIONS_DIR ?
    join(CORRECTIONS_DIR, "disruptions")
  : join(REGION_DIR, "disruptions");

// Gitignored downloads, recordings and build output.
export const VAR_DIR = join(ROOT, "var");
export const RAW_DIR = join(VAR_DIR, "raw");
export const GTFS_RAW_DIR = join(RAW_DIR, "gtfs");
export const RT_HISTORY_DIR = join(VAR_DIR, "rt-history");
export const AIS_HISTORY_DIR = join(VAR_DIR, "ais-history");
export const DISPATCH_HISTORY_DIR = join(VAR_DIR, "dispatch-history");
/** Trackside camera passes and number crops without a database, replays and cached OCR models. */
export const TRACKSIDE_DIR = join(VAR_DIR, "trackside");
/** The server's export of confirmed corrections from its database (TRANSITOPIA_CORRECTIONS_DIR). */
export const CORRECTIONS_EXPORT_DIR = join(VAR_DIR, "corrections");
/** Served at the web root by the transit viewer (/data/…, /tiles/…, /basemap-assets/…). */
export const PUBLIC_DIR = join(VAR_DIR, "public");
export const PUBLIC_DATA_DIR = join(PUBLIC_DIR, "data");
export const FEEDS_OUT_DIR = join(PUBLIC_DATA_DIR, "feeds");

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Write JSON atomically (temp file + rename) so a crashed build never leaves a half-written file. */
export async function writeJson(
  path: string,
  value: unknown,
  pretty = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : undefined));
  await rename(tmp, path);
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
