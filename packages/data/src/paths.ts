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
  parseNetwork,
  parseOperator,
  parseRegion,
  resolveKinematics,
  resolveRt,
  type Config,
  type FeedInfo,
  type NetworkInfo,
  type OperatorInfo,
  type RegionInfo,
} from "@transitopia/transit-core/config.ts";
import { cyclingDataPath } from "@transitopia/cycling-core/published.ts";
import {
  feedDataPath,
  networkDataPath,
  type FeedManifest,
} from "@transitopia/transit-core/plan/types.ts";

export const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// Committed, curated inputs (config/, docs/DESIGN.md#feeds-operators-and-rail-networks): global
// defaults, operators, the feeds they run (feed.json, routes.json, ferry berths and lanes, observations), rail
// networks (network.json and settings, infrastructure, scenarios, disruptions) and regions (region.json).
export const CONFIG_ROOT = join(ROOT, "config");
export const DEFAULTS_DIR = join(CONFIG_ROOT, "defaults");
export const OPERATORS_DIR = join(CONFIG_ROOT, "operators");
export const FEEDS_DIR = join(CONFIG_ROOT, "feeds");
export const NETWORKS_DIR = join(CONFIG_ROOT, "networks");
export const REGIONS_DIR = join(CONFIG_ROOT, "regions");
/** config/cycling/cycling.json: the cycling map's area and classification (readCyclingConfig). */
export const CYCLING_CONFIG_DIR = join(CONFIG_ROOT, "cycling");

// Corrections: the committed files, or on the server an export of the confirmed ones from its
// database (TRANSITOPIA_CORRECTIONS_DIR, laid out like config/: correctionPaths).
const CORRECTIONS_DIR = process.env.TRANSITOPIA_CORRECTIONS_DIR;

/** Where a rail network's curated files are (config/networks/<network>/). */
export function networkPaths(network: string): {
  dir: string;
  /** Track infrastructure (tracks.generated.geojson, overrides.json, …). */
  infra: string;
  scenarios: string;
} {
  const dir = join(NETWORKS_DIR, network);
  return {
    dir,
    infra: join(dir, "infrastructure"),
    scenarios: join(dir, "scenarios"),
  };
}

/**
 * Where a rail network's corrections are as files, under a directory laid out like config/: its
 * feed's observations (feeds/<feed>/observations/) and its disruptions (networks/<id>/disruptions/).
 * By default the committed files, or on the server the export the pipelines read
 * (TRANSITOPIA_CORRECTIONS_DIR).
 */
export function correctionPaths(
  net: RailNetwork,
  root: string = CORRECTIONS_DIR ?? CONFIG_ROOT,
): { observations: string; disruptions: string } {
  return {
    observations: join(root, "feeds", net.feed, "observations"),
    disruptions: join(root, "networks", net.network, "disruptions"),
  };
}

// Gitignored downloads, recordings and build output.
export const VAR_DIR = join(ROOT, "var");
export const RAW_DIR = join(VAR_DIR, "raw");
/** var/raw/gtfs/<feed>/<version dir>/google_transit.zip. */
export const GTFS_RAW_DIR = join(RAW_DIR, "gtfs");
/** var/rt-history/<feed>/: each feed's recordings. */
export const RT_HISTORY_DIR = join(VAR_DIR, "rt-history");
export const AIS_HISTORY_DIR = join(VAR_DIR, "ais-history");
export const DISPATCH_HISTORY_DIR = join(VAR_DIR, "dispatch-history");
/** The server's export of confirmed corrections from its database (TRANSITOPIA_CORRECTIONS_DIR). */
export const CORRECTIONS_EXPORT_DIR = join(VAR_DIR, "corrections");
/** Served at the web root by the transit viewer (/data/…, /tiles/…, /basemap-assets/…). */
export const PUBLIC_DIR = join(VAR_DIR, "public");
export const PUBLIC_DATA_DIR = join(PUBLIC_DIR, "data");
/** var/public/data as uploaded, its text files compressed (apps/server/src/jobs/publish.ts). */
export const PUBLISH_DATA_DIR = join(VAR_DIR, "publish", "data");

/** Where the cycling map's files for an area (config/cycling/cycling.json → area.id) are, on disk. */
export function cyclingPaths(area: string): {
  /** var/raw/osm-extracts/<area>/: Geofabrik extracts by OSM data date (YYYY-MM-DD.osm.pbf). */
  extracts: string;
  /** var/raw/osm-cycling/<area>/: what osmium keeps for the cycling map (<date>.opl.gz, latest.json). */
  osm: string;
  /** Published: index.json, tiles/<hash>.pmtiles (packages/cycling-core/README.md#published-files). */
  out: string;
  /** var/cycling/<area>/lookup.json: the latest build's OSM refs, for the feature resolver (packages/cycling-core/README.md#lookup). */
  lookup: string;
  /** var/cycling/<area>/routes.json: the latest build's bike routes, for the server's database (packages/cycling-core/README.md#bike-routes). */
  routes: string;
} {
  return {
    extracts: join(RAW_DIR, "osm-extracts", area),
    osm: join(RAW_DIR, "osm-cycling", area),
    out: join(PUBLIC_DIR, cyclingDataPath(area)),
    lookup: join(VAR_DIR, "cycling", area, "lookup.json"),
    routes: join(VAR_DIR, "cycling", area, "routes.json"),
  };
}

/** Where a feed's files are, on disk. */
export function feedPaths(feed: string): {
  /** config/feeds/<feed>: feed.json, routes.json, and where it has them observations/ and ferries/. */
  dir: string;
  /** Ferry routes' berths and lanes (ferries/<route>.json), used instead of their GTFS shapes. */
  ferries: string;
  /** Archived GTFS zips, one directory per version. */
  raw: string;
  /** Published: manifest.json, and <version dir>/{plan.json, movements/, platforms.json, rt-profile.<band>.bin}. */
  out: string;
  manifest: string;
  /** Real-time recordings (hour files, service changes, alerts, coverage, the request ledger). */
  rtHistory: string;
  /** AIS recordings of its vessels (hour files, coverage), where it has them (feed.json → ais). */
  aisHistory: string;
  /** OSM roads its buses run on (fetch-osm-roads), for matching bus shapes to streets. */
  roads: string;
} {
  return {
    dir: join(FEEDS_DIR, feed),
    ferries: join(FEEDS_DIR, feed, "ferries"),
    raw: join(GTFS_RAW_DIR, feed),
    out: join(PUBLIC_DIR, feedDataPath(feed)),
    manifest: join(PUBLIC_DIR, feedDataPath(feed, undefined, "manifest.json")),
    rtHistory: join(RT_HISTORY_DIR, feed),
    aisHistory: join(AIS_HISTORY_DIR, feed),
    roads: join(RAW_DIR, "osm-roads", feed),
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

/** Where a rail network's published files are, on disk: var/public/data/networks/<network>/. */
export function networkDataDir(network: string): string {
  return join(PUBLIC_DIR, networkDataPath(network));
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

/**
 * A feed's ferry routes' berths and lanes (ferries/<route>.json), checked, each with its file; none
 * for a feed without ferries/.
 */
export async function readFerries(
  feed: string,
): Promise<{ path: string; ferry: Config<"ferry"> }[]> {
  const dir = feedPaths(feed).ferries;
  if (!(await exists(dir))) return [];
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (n) => ({
      path: join(dir, n),
      ferry: parseConfig("ferry", await readJson<unknown>(join(dir, n))),
    })),
  );
}

/** Every feed some region shows, checked, in region then listing order. */
export async function readFeeds(): Promise<FeedInfo[]> {
  const ids = [...new Set((await readRegions()).flatMap((r) => r.feeds))];
  return Promise.all(ids.map(readFeed));
}

/** A rail network's network.json, checked. */
export async function readNetwork(id: string): Promise<NetworkInfo> {
  return parseNetwork(
    await readJson<unknown>(join(NETWORKS_DIR, id, "network.json")),
  );
}

/** Every rail network (config/networks/*), checked. */
export async function readNetworks(): Promise<NetworkInfo[]> {
  return Promise.all((await subdirs(NETWORKS_DIR)).map(readNetwork));
}

/** A feed's published manifest (its built versions); empty when nothing is built yet. */
export async function readManifest(feed: string): Promise<FeedManifest> {
  const path = feedPaths(feed).manifest;
  if (!(await exists(path)))
    return { schema: 1, generatedAt: new Date(0).toISOString(), feeds: [] };
  return readJson<FeedManifest>(path);
}

/** A feed's routes.json: overrides and exclusions of its routes (config/feeds/<feed>/routes.json). */
export async function readFeedRoutes(feed: string): Promise<Config<"routes">> {
  return parseConfig(
    "routes",
    await readJson<unknown>(join(FEEDS_DIR, feed, "routes.json")),
  );
}

/**
 * A rail network's settings file (config/networks/<network>/<name>.json: dispatch, operations),
 * checked against its schema (packages/transit-core/src/config.ts). Vehicle settings come in
 * layers: readFeedConfig.
 */
export async function readNetworkConfig<N extends "dispatch" | "operations">(
  name: N,
  network: string,
): Promise<Config<N>> {
  return parseConfig(
    name,
    await readJson<unknown>(join(NETWORKS_DIR, network, `${name}.json`)),
  );
}

/** The cycling map's settings (config/cycling/cycling.json), checked. */
export async function readCyclingConfig(): Promise<Config<"cycling">> {
  return parseConfig(
    "cycling",
    await readJson<unknown>(join(CYCLING_CONFIG_DIR, "cycling.json")),
  );
}

/**
 * A rail network (config/networks/<network>/) and a feed whose track-level routes (kind "skytrain",
 * e.g. TransLink's SkyTrain) run on it (network.json → feeds): what the rail pipelines, run inference
 * and the dispatcher work on (docs/DESIGN.md#feeds-operators-and-rail-networks).
 */
export interface RailNetwork {
  network: string;
  feed: string;
}

/** Every rail network with each feed on it, by network then feed. */
export async function railNetworks(): Promise<RailNetwork[]> {
  const out: RailNetwork[] = [];
  for (const n of await readNetworks())
    for (const feed of n.feeds) {
      if (
        !(await readFeedRoutes(feed)).routes.some((x) => x.kind === "skytrain")
      )
        throw new Error(
          `Network ${n.id} lists feed ${feed}, which has no track-level routes (routes.json → kind "skytrain")`,
        );
      out.push({ network: n.id, feed });
    }
  return out;
}

/** The rail networks given by `--network <id>` (as many times as wanted), or every one. */
export async function railNetworksArg(
  argv: readonly string[] = process.argv,
): Promise<RailNetwork[]> {
  const ids = argv.flatMap((a, i) =>
    a === "--network" && argv[i + 1] ? [argv[i + 1]!] : [],
  );
  const all = await railNetworks();
  for (const id of ids)
    if (!all.some((n) => n.network === id))
      throw new Error(
        `No rail network ${id} (config/networks/: ${[...new Set(all.map((n) => n.network))].join(", ")})`,
      );
  return ids.length ? all.filter((n) => ids.includes(n.network)) : all;
}

/**
 * The rail network, for what supports only one so far: the server's live dispatcher, its corrections
 * and /admin. Fails clearly when there are several (or none).
 */
export async function railNetwork(): Promise<RailNetwork> {
  const nets = await railNetworks();
  if (nets.length !== 1)
    throw new Error(
      `Expected exactly one rail network with one feed, found ${nets.length} (${nets.map((n) => `${n.feed} on ${n.network}`).join(", ") || "none"}): the server's live dispatcher, corrections and /admin support one so far`,
    );
  return nets[0]!;
}

/** A rail network's vehicle settings (its feed's). */
export function railFeedConfig(
  net: RailNetwork,
): ReturnType<typeof readFeedConfig> {
  return readFeedConfig(net.feed);
}

/** An operator's operator.json, checked. */
export async function readOperator(id: string): Promise<OperatorInfo> {
  return parseOperator(
    await readJson<unknown>(join(OPERATORS_DIR, id, "operator.json")),
  );
}

/** Every operator (config/operators/*), checked. */
export async function readOperators(): Promise<OperatorInfo[]> {
  return Promise.all((await subdirs(OPERATORS_DIR)).map(readOperator));
}

/**
 * A feed's vehicle and real-time settings: config/defaults/, then its operator's overrides, its own
 * and its routes' (kinematics).
 */
export async function readFeedConfig(
  feed: string,
): Promise<{ kinematics: Config<"kinematics">; rt: Config<"rt"> }> {
  const info = await readFeed(feed);
  const op = await readOperator(info.operator);
  return {
    kinematics: resolveKinematics(
      await readJson<unknown>(join(DEFAULTS_DIR, "kinematics.json")),
      op,
      info,
      (await readFeedRoutes(feed)).routes,
    ),
    rt: resolveRt(
      await readJson<unknown>(join(DEFAULTS_DIR, "rt.json")),
      op,
      info,
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

/** Write JSON atomically (writeAtomic). */
export async function writeJson(
  path: string,
  value: unknown,
  pretty = false,
): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Write a file atomically (temp file + rename) so a crashed build never leaves a half-written file. */
export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
