// The regions /transit can show, found in config/ (docs/DESIGN.md#feeds-operators-and-rail-networks),
// each with its feeds, their settings resolved from the defaults and their operators
// (packages/transit-core/src/config.ts), and the rail networks they run on, if any; checked as the
// transit chunk loads. Adding a region is data only. The map shows one region at a time, every feed
// it lists at once: the one in view (TransitMap.tsx).

import {
  parseConfig,
  parseFeed,
  parseNetwork,
  parseOperator,
  parseRegion,
  resolveKinematics,
  resolveRt,
  type NetworkInfo,
  type RegionInfo,
} from "@transitopia/transit-core/config.ts";
import type { FeedConfig } from "@transitopia/transit-map/engine.ts";

/** Where /transit opens without a map position. */
const DEFAULT_REGION_ID = "metro-vancouver";

type Files = Record<string, unknown>;
// Glob options are inline: Vite reads them statically.
// Keys are paths: …/config/<kind>/<id>/<file>.json.
const regionFiles: Files = import.meta.glob(
  "../../../../config/regions/*/region.json",
  { eager: true, import: "default" },
);
const networkFiles: Files = import.meta.glob(
  "../../../../config/networks/*/{network,operations}.json",
  { eager: true, import: "default" },
);
const feedFiles: Files = import.meta.glob(
  "../../../../config/feeds/*/{feed,routes}.json",
  { eager: true, import: "default" },
);
const operatorFiles: Files = import.meta.glob(
  "../../../../config/operators/*/operator.json",
  { eager: true, import: "default" },
);
const defaults: Files = import.meta.glob(
  "../../../../config/defaults/{kinematics,rt}.json",
  { eager: true, import: "default" },
);

/** The file `<kind>/<id>/<name>.json` among `files`, if there is one. */
function file(files: Files, kind: string, id: string, name: string): unknown {
  const suffix = `/config/${kind}/${id}/${name}.json`;
  return Object.entries(files).find(([path]) => path.endsWith(suffix))?.[1];
}

function defaultsFile(name: string): unknown {
  const f = Object.entries(defaults).find(([path]) =>
    path.endsWith(`/config/defaults/${name}.json`),
  )?.[1];
  if (f === undefined) throw new Error(`config/defaults/${name}.json missing`);
  return f;
}

export interface SiteRegion {
  info: RegionInfo;
  /** Its feeds' configs (region.json → feeds), for the engine (TransitEngineOptions.feeds). */
  feeds: FeedConfig[];
}

function siteRegion(info: RegionInfo): SiteRegion {
  return { info, feeds: info.feeds.map(feedConfig) };
}

/** A feed's config, with its operator's and the defaults' settings and its rail network, if any. */
function feedConfig(feedId: string): FeedConfig {
  const feed = parseFeed(file(feedFiles, "feeds", feedId, "feed"));
  const routes = parseConfig(
    "routes",
    file(feedFiles, "feeds", feedId, "routes"),
  );
  const op = parseOperator(
    file(operatorFiles, "operators", feed.operator, "operator"),
  );
  const net = NETWORKS.find((n) => n.feeds.includes(feedId));
  return {
    feed,
    kinematics: resolveKinematics(
      defaultsFile("kinematics"),
      op,
      feed,
      routes.routes,
    ),
    rt: resolveRt(defaultsFile("rt"), op, feed),
    ...(net ?
      {
        rail: {
          network: net.id,
          operations: parseConfig(
            "operations",
            file(networkFiles, "networks", net.id, "operations"),
          ),
        },
      }
    : {}),
  };
}

/** Every rail network (config/networks/*). */
const NETWORKS: readonly NetworkInfo[] = Object.entries(networkFiles)
  .filter(([path]) => path.endsWith("/network.json"))
  .map(([, json]) => parseNetwork(json));

/** Every region: the default first, then by name. */
export const REGIONS: readonly SiteRegion[] = Object.values(regionFiles)
  .map((json) => siteRegion(parseRegion(json)))
  .sort(
    (a, b) =>
      Number(b.info.id === DEFAULT_REGION_ID)
        - Number(a.info.id === DEFAULT_REGION_ID)
      || a.info.name.localeCompare(b.info.name),
  );

/** Where /transit opens without a map position. */
export const DEFAULT_REGION: SiteRegion =
  REGIONS.find((r) => r.info.id === DEFAULT_REGION_ID) ?? REGIONS[0]!;

/**
 * The rail network whose corrections /admin reviews: the server's live dispatcher and corrections
 * support one so far.
 */
export function railNetwork(): NetworkInfo {
  if (NETWORKS.length !== 1)
    throw new Error(`Expected one rail network, found ${NETWORKS.length}`);
  return NETWORKS[0]!;
}

/** [[west, south], [east, north]] for MapLibre. */
export function lngLatBounds(
  b: readonly [number, number, number, number],
): [[number, number], [number, number]] {
  return [
    [b[0], b[1]],
    [b[2], b[3]],
  ];
}

/**
 * The region the view shows most of (by the area of its bbox in view), or undefined if the view
 * overlaps none. Regions don't overlap (a test checks), so near one region this is that region.
 */
export function regionInView(view: {
  west: number;
  south: number;
  east: number;
  north: number;
}): SiteRegion | undefined {
  let best: { r: SiteRegion; area: number } | undefined;
  for (const r of REGIONS) {
    const [w, s, e, n] = r.info.bbox;
    const dx = Math.min(e, view.east) - Math.max(w, view.west);
    const dy = Math.min(n, view.north) - Math.max(s, view.south);
    if (dx <= 0 || dy <= 0) continue;
    const area = dx * dy;
    if (!best || area > best.area) best = { r, area };
  }
  return best?.r;
}
