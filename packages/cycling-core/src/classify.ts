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
   * No bike facility: a way of a bike route that isn't a cycling way (an ordinary road) or a ferry.
   * Only in route summaries (`comfortM`); classified ways are 1–4.
   */
  none: 0,
} as const;

/** A classified way's comfort, 1–4. */
export type Comfort = Exclude<
  (typeof COMFORT)[keyof typeof COMFORT],
  typeof COMFORT.none
>;

/** A way's attributes, as the tiles carry them (CyclingWayProperties in tiles.ts): a facility or a ferry. */
export type WayClass = FacilityClass | FerryClass;

/** A ferry crossing that takes bicycles: a way to get across, not a facility, so it has no comfort. */
export type FerryClass = {
  class: "ferry";
  oneway: 0;
};

/** A path's or lane's attributes. */
export type FacilityClass = {
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
  /**
   * A two-way road with a different facility each way (a painted lane one way, a shared lane the
   * other): `comfort` is the lower of the two.
   */
  varies_by_direction?: true;
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
const SHARED = ["shared_lane", "shared"];
const CYCLEWAY_KEYS = [
  "cycleway",
  "cycleway:both",
  "cycleway:left",
  "cycleway:right",
];
/** Roads for motor vehicles (https://wiki.openstreetmap.org/wiki/Key:highway#Roads), not steps or construction. */
const ROADS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
  "living_street",
  "service",
  "road",
];

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

  // Before the facilities: a ferry tagged as a road (rare) is still a ferry.
  if (isFerry(t) && !has(t, "bicycle", "no"))
    return { class: "ferry", oneway: 0 };
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
    side: NonNullable<FacilityClass["side"]>,
    oneway: FacilityClass["oneway"],
    dooring: boolean,
  ): FacilityClass => ({
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
    (has(t, "highway") && has(t, "cycleway", ...SHARED))
    || has(t, "cycleway:both", ...SHARED)
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
  const mixedLaneSide =
    has(t, "cycleway:right", "lane") && has(t, "cycleway:left", ...SHARED) ?
      "right"
    : has(t, "cycleway:left", "lane") && has(t, "cycleway:right", ...SHARED) ?
      "left"
    : undefined;
  if (has(t, "highway") && !has(t, "oneway", "yes") && mixedLaneSide) {
    // A painted lane one way and a shared lane the other (Stevens Drive, West Vancouver:
    // https://www.openstreetmap.org/way/59432713). With one line for both directions, it's rated
    // by the less comfortable of the two, and it's shared with traffic.
    const dooring =
      has(t, "parking:both", ...PARKING_BESIDE)
      || has(t, `parking:${mixedLaneSide}`, ...PARKING_BESIDE);
    const sharedComfort =
      has(t, "motor_vehicle", "private") || calm() ?
        COMFORT.high
      : COMFORT.least;
    const laneClass = lane(mixedLaneSide, 0, dooring);
    return {
      ...laneClass,
      comfort: Math.min(laneClass.comfort, sharedComfort) as Comfort,
      shared_with_vehicles: true,
      varies_by_direction: true,
    };
  }
  if (
    has(t, "highway", ...ROADS)
    && has(t, "bicycle", "designated")
    // A side's facility mapped as its own way (`separate`) is drawn as that way, and a track on one
    // side isn't recognised yet: either way, the road itself isn't the facility (Drake Street,
    // Vancouver: https://www.openstreetmap.org/way/100761389).
    && !CYCLEWAY_KEYS.some((k) => has(t, k, "separate", "track"))
  ) {
    if (has(t, "motor_vehicle", "no") || has(t, "access", "no")) {
      // Closed to motor vehicles: a path, as a farm or forest road closed to them is.
      const peds = has(t, "foot", "designated") && !has(t, "segregated", "yes");
      return {
        class: "track",
        subclass: "path",
        comfort: peds ? COMFORT.high : COMFORT.most,
        oneway: onewayYes,
        shared_with_pedestrians: peds,
        shared_with_vehicles: false,
      };
    }
    // Any other road designated for bicycles with no facility of its own: a street shared with
    // traffic, comfortable if calm (Nelson Avenue, West Vancouver: https://www.openstreetmap.org/way/45678152),
    // otherwise the least (motorway shoulders, for example). A road with no `maxspeed` isn't calm:
    // its speed limit is fixed in OSM rather than guessed here.
    return {
      class: "lane",
      comfort: calm() ? COMFORT.high : COMFORT.least,
      oneway: sharedOneway,
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
    };
  }
  // Not yet: other kinds, e.g. a track one way and a lane the other.
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
  // Substring: a route for several modes lists them (`route=hiking;bicycle`, as the Trans Canada
  // Trail's BC superroute does); isBikeRoute picks out the bike routes.
  "r/route=*bicycle*",
];

/** Whether a way is a ferry crossing (https://wiki.openstreetmap.org/wiki/Tag:route%3Dferry), which bike routes include. */
export const isFerry = (t: Tags): boolean => has(t, "route", "ferry");

/** Whether the element is bike parking (https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbicycle_parking). */
export const isBikeParking = (t: Tags): boolean =>
  has(t, "amenity", "bicycle_parking");

/**
 * Whether a relation is a bike route: a route (whose ways the tiles name in `routes`), or a
 * superroute, which contains only other routes (https://wiki.openstreetmap.org/wiki/Relation:superroute).
 * `route` can list several modes (`hiking;bicycle`).
 */
export const isBikeRoute = (t: Tags): boolean =>
  has(t, "type", "route", "superroute")
  && (t.route?.split(";").some((v) => v.trim() === "bicycle") ?? false);
