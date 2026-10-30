// What kind of cycling facility an OSM way is, and how comfortable it is to ride
// (packages/cycling-core/README.md#classification). Ported from the Planetiler profile this
// replaced (map-layers/…/layers/Cycling.java), rule for rule and in the same order, with footways,
// bridleways and tracks since: the first rule that matches decides.

import type { Config } from "@transitopia/transit-core/config.ts";
import type { Tags } from "./osm.ts";

/** How comfortable a facility is for most people, from 4 (most) to 1 (least). */
export const COMFORT = {
  /** A fully separated bike track that's off-street or has a physical barrier separating it from traffic. */
  most: 4,
  /** E.g. a shared lane on a quiet neighbourhood street, or a path shared with pedestrians. */
  high: 3,
  /** E.g. a painted bike lane, not separated from traffic. */
  low: 2,
  /** E.g. a shared lane on a busy street, or a painted lane beside parked cars. */
  least: 1,
  /**
   * No bike facility: a way of a bike route that isn't a cycling way (an ordinary road). Only in
   * route summaries (`comfortM`); classified ways are 1–4.
   */
  none: 0,
} as const;

/** A classified way's comfort, 1–4. */
export type Comfort = Exclude<
  (typeof COMFORT)[keyof typeof COMFORT],
  typeof COMFORT.none
>;

/** A path's or lane's attributes, as the tiles carry them (CyclingWayProperties in tiles.ts). */
export type WayClass = {
  /** "track": separate from the roadway (off-road); "lane": within it (on-road). */
  class: "track" | "lane";
  /** For tracks: "cycleway", "path", or "combined-<highway>" (a track beside a road, tagged on the road). */
  subclass?: string;
  comfort: Comfort;
  /** 1: one-way along the way; -1: against it; 0: both ways. */
  oneway: -1 | 0 | 1;
  /** For lanes on one side of the road: which side ("both" when there's a lane on each). */
  side?: "both" | "left" | "right";
  shared_with_pedestrians: boolean;
  shared_with_vehicles: boolean;
  /** A painted lane beside parked cars. */
  dooring_risk?: true;
  construction?: true;
  website?: string;
  opening_date?: string;
};

export type ClassifyConfig = Config<"cycling">["classify"];

/** Whether the way has the tag, with one of the values if any are given (Planetiler's hasTag). */
function has(tags: Tags, key: string, ...values: string[]): boolean {
  const v = tags[key];
  return values.length ?
      v !== undefined && values.includes(v)
    : v !== undefined;
}

/** km/h in a mile per hour. */
const KMH_PER_MPH = 1.609344;
/** maxspeed=walk, in km/h. */
const WALK_KMH = 6;

/**
 * A `maxspeed` value in km/h (https://wiki.openstreetmap.org/wiki/Key:maxspeed): a number, in km/h
 * unless it says mph; `walk` as walking pace; the fastest of several (`50;30`). Undefined for
 * anything else, such as implied limits (`CA:urban`), `none` or `signals`: they aren't slow.
 */
export function maxspeedKmh(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  let fastest: number | undefined;
  for (const part of v.split(";")) {
    const p = part.trim();
    const m = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph)?$/.exec(p);
    const kmh =
      p === "walk" ? WALK_KMH
      : m ? Number(m[1]) * (m[2] === "mph" ? KMH_PER_MPH : 1)
      : undefined;
    if (kmh === undefined) return undefined;
    fastest = Math.max(fastest ?? 0, kmh);
  }
  return fastest;
}

const PARKING_BESIDE = ["separate", "lane", "street_side"];

/** The way's cycling facility, or undefined if it isn't one. */
export function classifyWay(
  t: Tags,
  config: ClassifyConfig,
): WayClass | undefined {
  const onewayYes = has(t, "oneway", "yes") ? 1 : 0;
  const calm = () =>
    (maxspeedKmh(t.maxspeed) ?? Infinity) <= config.calmMaxSpeedKmh;
  // A shared road's one-way: the road's, unless bicycles are exempt.
  const sharedOneway = has(t, "oneway:bicycle", "no") ? 0 : onewayYes;

  // OSM distinguishes cycle tracks, separate from the road (by curbs, parking, verges, trees…),
  // from cycle lanes, on the road itself.
  if (has(t, "highway", "cycleway")) {
    const peds = has(t, "foot", "designated") && has(t, "segregated", "no");
    return {
      class: "track",
      subclass: "cycleway",
      comfort: peds ? COMFORT.high : COMFORT.most,
      // 'reverse' one-way (-1) isn't supported for tracks.
      oneway: onewayYes,
      shared_with_pedestrians: peds,
      shared_with_vehicles: false,
    };
  }
  if (
    has(t, "highway", "path", "pedestrian", "footway", "bridleway")
    && has(t, "bicycle", "designated")
  ) {
    // Pedestrian streets and footways (sidewalks included) are for pedestrians first, and
    // bridleways for horses.
    const peds =
      (has(t, "foot", "designated")
        || has(t, "highway", "pedestrian", "footway"))
      && !has(t, "segregated", "yes");
    return {
      class: "track",
      subclass: "path",
      comfort:
        peds || has(t, "highway", "bridleway") ? COMFORT.high : COMFORT.most,
      oneway: onewayYes,
      shared_with_pedestrians: peds,
      shared_with_vehicles: false,
    };
  }
  if (has(t, "highway", "track")) {
    // Farm and forest roads, and the rail trails mapped as them (the Kettle Valley Rail Trail).
    // Closed to motor vehicles and open to bicycles, it's a path; designated for bicycles but open
    // to motor vehicles, a quiet road shared with them. Neither said, it isn't a cycling facility.
    if (
      has(t, "motor_vehicle", "no")
      && has(t, "bicycle", "yes", "designated", "permissive")
    ) {
      const peds = has(t, "foot", "designated") && !has(t, "segregated", "yes");
      return {
        class: "track",
        subclass: "track",
        // Even if shared with pedestrians, such farm/forest roads are still "most" comfortable.
        comfort: COMFORT.most,
        oneway: onewayYes,
        shared_with_pedestrians: peds,
        shared_with_vehicles: false,
      };
    }
    if (has(t, "bicycle", "designated"))
      return {
        class: "lane",
        comfort: COMFORT.high,
        oneway: sharedOneway,
        shared_with_pedestrians: false,
        shared_with_vehicles: true,
      };
  }
  if (has(t, "highway") && has(t, "cycleway", "track")) {
    const peds = has(t, "foot", "designated") && !has(t, "segregated", "yes");
    return {
      class: "track",
      subclass: `combined-${t.highway}`,
      comfort: peds ? COMFORT.high : COMFORT.most,
      oneway: onewayYes,
      shared_with_pedestrians: peds,
      shared_with_vehicles: false,
    };
  }
  if (has(t, "highway", "construction") && has(t, "construction", "cycleway")) {
    const peds = has(t, "foot", "designated") && !has(t, "segregated", "yes");
    return {
      class: "track",
      subclass: "cycleway",
      comfort: peds ? COMFORT.high : COMFORT.most,
      oneway: onewayYes,
      shared_with_pedestrians: peds,
      shared_with_vehicles: false,
      construction: true,
      ...(t.website === undefined ? {} : { website: t.website }),
      ...(t.opening_date === undefined ? {} : { opening_date: t.opening_date }),
    };
  }
  // Not yet: "T2 (alternative)" on https://wiki.openstreetmap.org/wiki/Bicycle
  // (cycleway:right=track + cycleway:right:oneway=no).
  const lane = (
    side: NonNullable<WayClass["side"]>,
    oneway: WayClass["oneway"],
    dooring: boolean,
  ): WayClass => ({
    class: "lane",
    side,
    comfort: dooring ? COMFORT.least : COMFORT.low,
    oneway,
    shared_with_pedestrians: false,
    shared_with_vehicles: false,
    ...(dooring ? { dooring_risk: true as const } : {}),
  });
  if (
    has(t, "highway")
    && !has(t, "oneway", "yes")
    && (has(t, "cycleway", "lane")
      || has(t, "cycleway:both", "lane")
      || (has(t, "cycleway:left", "lane") && has(t, "cycleway:right", "lane")))
  ) {
    // A lane on both sides of a two-way road. Parked cars beside either one are a dooring risk:
    // with one line for both directions, the whole road is downgraded. Parking mapped as separate
    // ways ("separate") isn't looked at; in BC so far it's always been beside the lane.
    const dooring =
      has(t, "parking", "lane", "street_side")
      || has(t, "parking:both", "lane", "street_side")
      || has(t, "parking:both", "separate")
      || has(t, "parking:right", ...PARKING_BESIDE)
      || has(t, "parking:left", ...PARKING_BESIDE);
    return lane("both", 0, dooring);
  }
  if (
    has(t, "highway")
    && !has(t, "oneway", "yes")
    && ((has(t, "cycleway:right", "lane")
      && has(t, "cycleway:right:oneway", "no"))
      || (has(t, "cycleway:left", "lane")
        && has(t, "cycleway:left:oneway", "no")))
  ) {
    // A two-way lane on one side of the road.
    return lane(has(t, "cycleway:right", "lane") ? "right" : "left", 0, false);
  }
  if (
    has(t, "highway")
    && has(t, "oneway", "yes")
    && (has(t, "cycleway", "lane")
      || has(t, "cycleway:right", "lane")
      || has(t, "cycleway:left", "lane"))
  ) {
    // A lane on a one-way road, one-way like the road unless there's a lane on each side.
    const side = has(t, "cycleway:left", "lane") ? "left" : "right";
    const both =
      has(t, "cycleway:right", "lane") && has(t, "cycleway:left", "lane");
    // A buffer between the lane and the parking isn't recognised yet (issue #39).
    return lane(
      side,
      both ? 0 : 1,
      has(t, `parking:${side}`, ...PARKING_BESIDE),
    );
  }
  // As the Planetiler profile had it: `cycleway:both` matches without a highway tag.
  if (
    (has(t, "highway") && has(t, "cycleway", "shared_lane", "shared"))
    || has(t, "cycleway:both", "shared_lane", "shared")
  ) {
    // A lane shared with motor vehicles.
    return {
      class: "lane",
      comfort:
        has(t, "motor_vehicle", "private") || calm() ?
          COMFORT.high
        : COMFORT.least,
      oneway: sharedOneway,
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
    };
  }
  if (
    has(t, "highway", "residential")
    && has(t, "bicycle", "yes", "designated")
    && calm()
  ) {
    // A slow street bicycles can use.
    return {
      class: "lane",
      comfort: COMFORT.high,
      oneway: sharedOneway,
      shared_with_pedestrians: has(t, "foot", "yes"),
      shared_with_vehicles: true,
    };
  }
  if (
    has(t, "highway")
    && ((has(t, "cycleway:right", "lane") && has(t, "cycleway:left", "no"))
      || (has(t, "cycleway:left", "lane") && has(t, "cycleway:right", "no")))
  ) {
    // A one-way lane on one side of a two-way road ("L2" on https://wiki.openstreetmap.org/wiki/Bicycle).
    const side = has(t, "cycleway:left", "lane") ? "left" : "right";
    return lane(
      side,
      side === "left" ? -1 : 1,
      has(t, "parking:both", ...PARKING_BESIDE)
        || has(t, `parking:${side}`, ...PARKING_BESIDE),
    );
  }
  // Not yet: other kinds, e.g. https://www.openstreetmap.org/way/74096518 (mixed lane + shared_lane).
  return undefined;
}

/**
 * What to keep from an extract (`osmium tags-filter` expressions): every way classifyWay can accept
 * has one of these tags, and so does bike parking and every bike route. osmium adds what they
 * reference (nodes, and route members).
 */
export const OSM_FILTERS = [
  "w/highway=cycleway",
  "w/bicycle",
  "w/cycleway",
  "w/cycleway:both",
  "w/cycleway:left",
  "w/cycleway:right",
  "w/construction=cycleway",
  "nwr/amenity=bicycle_parking",
  "r/route=bicycle",
];

/** Whether the element is bike parking (https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbicycle_parking). */
export const isBikeParking = (t: Tags): boolean =>
  has(t, "amenity", "bicycle_parking");

/**
 * Whether a relation is a bike route: a route (whose ways the tiles name in `routes`), or a
 * superroute, which contains only other routes (https://wiki.openstreetmap.org/wiki/Relation:superroute).
 */
export const isBikeRoute = (t: Tags): boolean =>
  has(t, "type", "route", "superroute") && has(t, "route", "bicycle");
