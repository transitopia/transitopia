// The regions /transit can show, found in config/ (docs/DESIGN.md#regions-and-feeds), each with its
// feed and that feed's settings resolved from the defaults, its operator and the region
// (packages/transit-core/src/config.ts), checked as the transit chunk loads. Adding a region is data
// only. The map shows one region at a time: the one in view (TransitMap.tsx).

import {
  parseConfig,
  parseFeed,
  parseOperator,
  parseRegion,
  parseRegionRt,
  resolveKinematics,
  resolveRt,
  type RegionInfo,
} from "@transitopia/transit-core/config.ts";
import type { RegionConfig } from "@transitopia/transit-map/engine.ts";

/** Where /transit opens without a map position. */
const DEFAULT_REGION_ID = "metro-vancouver";

type Files = Record<string, unknown>;
const json = { eager: true, import: "default" } as const;
// Keys are paths: …/config/<kind>/<id>/<file>.json.
const regionFiles: Files = import.meta.glob(
  "../../../../config/regions/*/region.json",
  json,
);
const regionSettings: Files = import.meta.glob(
  "../../../../config/regions/*/{rt,operations}.json",
  json,
);
const feedFiles: Files = import.meta.glob(
  "../../../../config/feeds/*/{feed,routes}.json",
  json,
);
const operatorFiles: Files = import.meta.glob(
  "../../../../config/operators/*/operator.json",
  json,
);
const defaults: Files = import.meta.glob(
  "../../../../config/defaults/{kinematics,rt}.json",
  json,
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
  config: RegionConfig;
}

function siteRegion(info: RegionInfo): SiteRegion {
  // The engine draws one feed per region for now (RegionConfig.feed).
  if (info.feeds.length !== 1)
    throw new Error(`Region ${info.id}: the site shows exactly one feed`);
  const feedId = info.feeds[0]!;
  const feed = parseFeed(file(feedFiles, "feeds", feedId, "feed"));
  const routes = parseConfig(
    "routes",
    file(feedFiles, "feeds", feedId, "routes"),
  );
  const op = parseOperator(
    file(operatorFiles, "operators", feed.operator, "operator"),
  );
  const rt = file(regionSettings, "regions", info.id, "rt");
  const operations = file(regionSettings, "regions", info.id, "operations");
  return {
    info,
    config: {
      feed,
      kinematics: resolveKinematics(
        defaultsFile("kinematics"),
        op,
        routes.routes,
      ),
      rt: resolveRt(
        defaultsFile("rt"),
        op,
        rt === undefined ? undefined : parseRegionRt(rt),
      ),
      ...(operations === undefined ?
        {}
      : { operations: parseConfig("operations", operations) }),
    },
  };
}

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
 * The region with track-level rail (operations config), whose corrections /admin reviews: the
 * server's live dispatcher and corrections support one so far.
 */
export function railRegion(): SiteRegion {
  const rail = REGIONS.filter((r) => r.config.operations);
  if (rail.length !== 1)
    throw new Error(
      `Expected one region with track-level rail, found ${rail.length}`,
    );
  return rail[0]!;
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
