// OSM_FILTERS run in GitHub Actions (pipelines/extract-cycling-osm.ts), before classification: a way
// the classifier accepts but the filters drop never reaches the tiles.

import { describe, expect, it } from "vitest";
import {
  OSM_FILTERS,
  classifyWay,
  isBikeParking,
  isBikeRoute,
} from "../src/classify.ts";
import type { Tags } from "../src/osm.ts";

/** Whether an osmium tags-filter expression (`nwr/key`, `nwr/key=value` or `nwr/key=*value*`) keeps an element. */
function kept(type: "n" | "w" | "r", tags: Tags): boolean {
  return OSM_FILTERS.some((f) => {
    const [types, expr] = f.split("/") as [string, string];
    const [key, value] = expr.split("=") as [string, string | undefined];
    return (
      types.includes(type)
      && tags[key] !== undefined
      && (value === undefined
        || (value.startsWith("*") && value.endsWith("*") ?
          tags[key].includes(value.slice(1, -1))
        : tags[key] === value))
    );
  });
}

/** One way for each of the classifier's rules, and its variants; the route-only rules in ROUTE_WAYS. */
const WAYS: Tags[] = [
  { highway: "cycleway" },
  { route: "ferry", bicycle: "yes" },
  { highway: "path", bicycle: "designated" },
  { highway: "pedestrian", bicycle: "designated" },
  { highway: "footway", bicycle: "designated" },
  { highway: "bridleway", bicycle: "designated" },
  { highway: "track", bicycle: "yes", motor_vehicle: "no" },
  { highway: "track", bicycle: "designated" },
  { highway: "secondary", cycleway: "track" },
  { highway: "construction", construction: "cycleway" },
  { highway: "secondary", cycleway: "lane" },
  { highway: "secondary", "cycleway:both": "lane" },
  { highway: "secondary", "cycleway:left": "lane", "cycleway:right": "lane" },
  {
    highway: "residential",
    "cycleway:left": "lane",
    "cycleway:left:oneway": "no",
  },
  { highway: "secondary", oneway: "yes", "cycleway:right": "lane" },
  { highway: "primary", cycleway: "shared_lane" },
  { "cycleway:both": "shared" },
  {
    highway: "residential",
    bicycle: "yes",
    maxspeed: "30",
  },
  { highway: "tertiary", "cycleway:left": "lane", "cycleway:right": "no" },
  {
    highway: "tertiary",
    "cycleway:left": "shared_lane",
    "cycleway:right": "lane",
  },
  { highway: "tertiary", bicycle: "designated" },
];

/** Ways that are cycling ways only in a bike route (`classifyWay`'s `inBikeRoute`). */
const ROUTE_WAYS: Tags[] = [
  { highway: "path", bicycle: "yes" },
  { highway: "bridleway", bicycle: "permissive" },
];

describe("OSM_FILTERS", () => {
  it("keeps every way the classifier accepts", () => {
    for (const tags of WAYS) {
      expect(classifyWay(tags, { calmMaxSpeedKmh: 30 })).toBeDefined();
      expect(kept("w", tags), JSON.stringify(tags)).toBe(true);
    }
    for (const tags of ROUTE_WAYS) {
      expect(classifyWay(tags, { calmMaxSpeedKmh: 30 }, true)).toBeDefined();
      expect(kept("w", tags), JSON.stringify(tags)).toBe(true);
    }
  });

  it("keeps bike parking and bike routes", () => {
    const parking = { amenity: "bicycle_parking" };
    expect(isBikeParking(parking) && kept("n", parking)).toBe(true);
    expect(kept("w", parking)).toBe(true);
    for (const route of [
      { type: "route", route: "bicycle" },
      { type: "superroute", route: "hiking;bicycle" },
    ])
      expect(isBikeRoute(route) && kept("r", route)).toBe(true);
  });
});
