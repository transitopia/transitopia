// The regions /transit can show, each with its config and feed for the transit engine, checked as the
// transit chunk loads (packages/transit-core/src/config.ts; docs/DESIGN.md#regions-and-feeds). The map
// shows one region at a time: the one in view (TransitMap.tsx).

import {
  parseConfig,
  parseFeed,
  parseRegion,
  type RegionInfo,
} from "@transitopia/transit-core/config.ts";
import type { RegionConfig } from "@transitopia/transit-map/engine.ts";
import mvRegion from "@transitopia/region-metro-vancouver/region.json";
import mvKinematics from "@transitopia/region-metro-vancouver/config/kinematics.json";
import mvOperations from "@transitopia/region-metro-vancouver/config/operations.json";
import mvRt from "@transitopia/region-metro-vancouver/config/rt.json";
import mvSeabus from "@transitopia/region-metro-vancouver/config/seabus.json";
import gvRegion from "@transitopia/region-greater-victoria/region.json";
import gvKinematics from "@transitopia/region-greater-victoria/config/kinematics.json";
import gvRt from "@transitopia/region-greater-victoria/config/rt.json";
import coRegion from "@transitopia/region-central-okanagan/region.json";
import coKinematics from "@transitopia/region-central-okanagan/config/kinematics.json";
import coRt from "@transitopia/region-central-okanagan/config/rt.json";
import translink from "@transitopia/feeds/translink/feed.json";
import bcTransitVictoria from "@transitopia/feeds/bc-transit-victoria/feed.json";
import bcTransitKelowna from "@transitopia/feeds/bc-transit-kelowna/feed.json";

export interface SiteRegion {
  info: RegionInfo;
  config: RegionConfig;
}

function region(
  json: unknown,
  feeds: unknown[],
  config: Omit<RegionConfig, "feed">,
): SiteRegion {
  const info = parseRegion(json);
  const parsed = feeds.map(parseFeed);
  const feed = parsed.find((f) => f.id === info.feeds[0]);
  // The engine draws one feed per region for now (RegionConfig.feed).
  if (!feed || info.feeds.length !== 1)
    throw new Error(`Region ${info.id}: the site shows exactly one feed`);
  return { info, config: { ...config, feed } };
}

export const REGIONS: readonly SiteRegion[] = [
  region(mvRegion, [translink], {
    kinematics: parseConfig("kinematics", mvKinematics),
    operations: parseConfig("operations", mvOperations),
    rt: parseConfig("rt", mvRt),
    seabus: parseConfig("seabus", mvSeabus),
  }),
  region(gvRegion, [bcTransitVictoria], {
    kinematics: parseConfig("kinematics", gvKinematics),
    rt: parseConfig("rt", gvRt),
  }),
  region(coRegion, [bcTransitKelowna], {
    kinematics: parseConfig("kinematics", coKinematics),
    rt: parseConfig("rt", coRt),
  }),
];

/** Where /transit opens without a map position. */
export const DEFAULT_REGION: SiteRegion = REGIONS[0]!;

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
