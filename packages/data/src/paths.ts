import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  stat,
} from "node:fs/promises";
import {
  parseConfig,
  parseFeed,
  parseOperator,
  parseRegion,
  parseRegionRt,
  resolveKinematics,
  resolveRt,
  type Config,
  type ConfigName,
  type FeedInfo,
  type OperatorInfo,
  type RegionInfo,
} from "@transitopia/transit-core/config.ts";
import {
  feedDataPath,
  regionDataPath,
  type FeedManifest,
} from "@transitopia/transit-core/plan/types.ts";

export const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// Committed, curated inputs (config/, docs/DESIGN.md#regions-and-feeds): global defaults, operators,
// the feeds they run (feed.json, routes.json) and regions (region.json and settings, infrastructure,
// scenarios, corrections).
export const CONFIG_ROOT = join(ROOT, "config");
export const DEFAULTS_DIR = join(CONFIG_ROOT, "defaults");
export const OPERATORS_DIR = join(CONFIG_ROOT, "operators");
export const FEEDS_DIR = join(CONFIG_ROOT, "feeds");
export const REGIONS_DIR = join(CONFIG_ROOT, "regions");

/**
 * The region with track-level rail: its track infrastructure, run inference, dispatcher, scenarios
 * and corrections. The rail pipelines and the server's dispatcher work on it alone for now.
 */
export const RAIL_REGION = "metro-vancouver";
/** The feed whose trains the rail pipelines model (SkyTrain, in TransLink's feed). */
export const RAIL_FEED = "translink";
export const REGION_DIR = join(REGIONS_DIR, RAIL_REGION);
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
/** var/raw/gtfs/<feed>/<version dir>/google_transit.zip. */
export const GTFS_RAW_DIR = join(RAW_DIR, "gtfs");
/** var/rt-history/<feed>/: each feed's recordings. The leader's lock file is at the top. */
export const RT_HISTORY_DIR = join(VAR_DIR, "rt-history");
export const AIS_HISTORY_DIR = join(VAR_DIR, "ais-history");
export const DISPATCH_HISTORY_DIR = join(VAR_DIR, "dispatch-history");
/** The server's export of confirmed corrections from its database (TRANSITOPIA_CORRECTIONS_DIR). */
export const CORRECTIONS_EXPORT_DIR = join(VAR_DIR, "corrections");
/** Served at the web root by the transit viewer (/data/…, /tiles/…, /basemap-assets/…). */
export const PUBLIC_DIR = join(VAR_DIR, "public");
export const PUBLIC_DATA_DIR = join(PUBLIC_DIR, "data");

/** Where a feed's files are, on disk. */
export function feedPaths(feed: string): {
  /** config/feeds/<feed>: feed.json, routes.json. */
  dir: string;
  /** Archived GTFS zips, one directory per version. */
  raw: string;
  /** Published: manifest.json, and <version dir>/{plan.json, movements/, platforms.json, rt-profile.json}. */
  out: string;
  manifest: string;
  /** Real-time recordings (hour files, service changes, alerts, coverage, the request ledger). */
  rtHistory: string;
  /** AIS recordings of its vessels (hour files, coverage), where it has them (feed.json → ais). */
  aisHistory: string;
} {
  return {
    dir: join(FEEDS_DIR, feed),
    raw: join(GTFS_RAW_DIR, feed),
    out: join(PUBLIC_DIR, feedDataPath(feed)),
    manifest: join(PUBLIC_DIR, feedDataPath(feed, undefined, "manifest.json")),
    rtHistory: join(RT_HISTORY_DIR, feed),
    aisHistory: join(AIS_HISTORY_DIR, feed),
  };
}

/** A published file of a feed version, on disk. */
export function feedVersionFile(
  feed: string,
  feedVersion: string,
  file: string,
): string {
  return join(PUBLIC_DIR, feedDataPath(feed, feedVersion, file));
}

/** Where a region's published files are, on disk: var/public/data/regions/<region>/. */
export function regionDataDir(region: string = RAIL_REGION): string {
  return join(PUBLIC_DIR, regionDataPath(region));
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function subdirs(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name !== "node_modules")
    .map((d) => d.name)
    .sort();
}

/** A region's region.json, checked. */
export async function readRegion(id: string): Promise<RegionInfo> {
  return parseRegion(
    await readJson<unknown>(join(REGIONS_DIR, id, "region.json")),
  );
}

/** Every region (config/regions/*), checked. */
export async function readRegions(): Promise<RegionInfo[]> {
  return Promise.all((await subdirs(REGIONS_DIR)).map(readRegion));
}

/** A feed's feed.json, checked. */
export async function readFeed(id: string): Promise<FeedInfo> {
  return parseFeed(await readJson<unknown>(join(FEEDS_DIR, id, "feed.json")));
}

/** Every feed some region shows, checked, in region then listing order. */
export async function readFeeds(): Promise<FeedInfo[]> {
  const ids = [...new Set((await readRegions()).flatMap((r) => r.feeds))];
  return Promise.all(ids.map(readFeed));
}

/** The first region showing a feed: whose config (kinematics, prediction) goes with it in scripts. */
export async function regionOfFeed(feed: string): Promise<RegionInfo> {
  const region = (await readRegions()).find((r) => r.feeds.includes(feed));
  if (!region) throw new Error(`No region shows feed ${feed}`);
  return region;
}

/** A feed's published manifest (its built versions); empty when nothing is built yet. */
export async function readManifest(feed: string): Promise<FeedManifest> {
  const path = feedPaths(feed).manifest;
  if (!(await exists(path)))
    return { schema: 1, generatedAt: new Date(0).toISOString(), feeds: [] };
  return readJson<FeedManifest>(path);
}

/** A feed's routes.json: which of its routes are drawn (config/feeds/<feed>/routes.json). */
export async function readFeedRoutes(feed: string): Promise<Config<"routes">> {
  return parseConfig(
    "routes",
    await readJson<unknown>(join(FEEDS_DIR, feed, "routes.json")),
  );
}

/**
 * A region's settings file (config/regions/<region>/<name>.json: dispatch, operations, recording,
 * seabus), checked against its schema (packages/transit-core/src/config.ts). Vehicle and real-time
 * settings come in layers: readFeedConfig.
 */
export async function readConfig<
  N extends Exclude<ConfigName, "kinematics" | "rt" | "routes">,
>(name: N, region: string = RAIL_REGION): Promise<Config<N>> {
  return parseConfig(
    name,
    await readJson<unknown>(join(REGIONS_DIR, region, `${name}.json`)),
  );
}

/** The rail feed's settings in the rail region (track-level rail: run inference, dispatch). */
export function railFeedConfig(): ReturnType<typeof readFeedConfig> {
  return readFeedConfig(RAIL_FEED, RAIL_REGION);
}

/** An operator's operator.json, checked. */
export async function readOperator(id: string): Promise<OperatorInfo> {
  return parseOperator(
    await readJson<unknown>(join(OPERATORS_DIR, id, "operator.json")),
  );
}

/**
 * A feed's vehicle and real-time settings as a region shows it: config/defaults/, then its
 * operator's overrides, its routes' (kinematics) and the region's (rt.json, where it has one).
 */
export async function readFeedConfig(
  feed: string,
  region: string,
): Promise<{ kinematics: Config<"kinematics">; rt: Config<"rt"> }> {
  const op = await readOperator((await readFeed(feed)).operator);
  const regionRt = join(REGIONS_DIR, region, "rt.json");
  return {
    kinematics: resolveKinematics(
      await readJson<unknown>(join(DEFAULTS_DIR, "kinematics.json")),
      op,
      (await readFeedRoutes(feed)).routes,
    ),
    rt: resolveRt(
      await readJson<unknown>(join(DEFAULTS_DIR, "rt.json")),
      op,
      (await exists(regionRt)) ?
        parseRegionRt(await readJson<unknown>(regionRt))
      : undefined,
    ),
  };
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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
