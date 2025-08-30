/**
 * OsmProcessor contains shared logic used both when generating the map, and when loading
 * data on-demand from OpenStreetMap. For example, the logic for how to compute the "comfort
 * level" of a bike lane is here, because we need it both when generating the map and when
 * the URL contains the ID of a specific bike lane to display, which we don't yet know how
 * to load from the map (we don't know which tile it's in).
 */

import { CyclingComfort, type MapCyclingWay } from "./MapFeatures";
import type { OsmTagRecord } from "./OsmTagSchema";

const tagIsOneOf = (
  tag: string | undefined,
  ...values: (string | undefined)[]
): boolean => values.includes(tag);
/** Safely parse a string as an integer, returning undefined if it's invalid */
const safeParseInt = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const intValue = parseInt(value, 10);
  return Number.isFinite(intValue) ? intValue : undefined;
};

export function deriveCyclingTags(
  osmWayId: number,
  rawOsmTags: OsmTagRecord,
): MapCyclingWay | undefined {
  const tags = rawOsmTags;

  const common: Pick<
    MapCyclingWay,
    "type" | "osm_way_id" | "name" | "surface"
  > = {
    type: "cycling/way",
    osm_way_id: osmWayId,
  };
  if (tags.name) {
    common.name = tags.name;
  }
  if (tags.surface) {
    common.surface = tags.surface;
  }

  // "OSM distinguishes between cycle "lanes" and cycle "tracks":
  // A cycle *track* is separate from the road (off-road).
  // Tracks are typically separated from the road by e.g. curbs, parking lots, grass verges, trees, etc."

  if (tags.highway === "cycleway") {
    // A track that is primarily for cycling, totally separate from road users
    const shared_with_pedestrians =
      tags.foot === "designated" && tags.segregated === "no";
    return {
      ...common,
      class: "track",
      shared_with_pedestrians,
      shared_with_vehicles: false,
      comfort:
        shared_with_pedestrians ? CyclingComfort.HIGH : CyclingComfort.MOST,
      oneway:
        tags.oneway === "yes" ? 1
        : tags.oneway === "-1" ? -1
        : 0,
    };
  } else if (
    tagIsOneOf(tags.highway, "path", "pedestrian")
    && tags.bicycle === "designated"
  ) {
    // A track that is primarily for pedestrians, but allows cycling, and is totally separate from road users
    const shared_with_pedestrians =
      (tags.foot === "designated" || tags.highway === "pedestrian")
      && tags.segregated !== "yes";
    return {
      ...common,
      class: "track",
      shared_with_pedestrians,
      shared_with_vehicles: false,
      comfort:
        shared_with_pedestrians ? CyclingComfort.HIGH : CyclingComfort.MOST,
      oneway:
        tags.oneway === "yes" ? 1
        : tags.oneway === "-1" ? -1
        : 0,
    };
  } else if ("highway" in tags && tags.cycleway === "track") {
    // a cycle way that is parallel to and next to the road, but is separated from traffic.
    const shared_with_pedestrians =
      tags.foot === "designated" && tags.segregated !== "yes";
    return {
      ...common,
      class: "track",
      shared_with_pedestrians,
      shared_with_vehicles: false,
      comfort:
        shared_with_pedestrians ? CyclingComfort.HIGH : CyclingComfort.MOST,
      oneway:
        tags.oneway === "yes" ? 1
        : tags.oneway === "-1" ? -1
        : 0,
    };
  } else if (
    tags.highway === "construction"
    && tags.construction === "cycleway"
  ) {
    // A bike track that is closed for construction
    const shared_with_pedestrians =
      tags.foot === "designated" && tags.segregated !== "yes";
    return {
      ...common,
      class: "track",
      construction: true,
      shared_with_pedestrians,
      shared_with_vehicles: false,
      comfort:
        shared_with_pedestrians ? CyclingComfort.HIGH : CyclingComfort.MOST,
      oneway:
        tags.oneway === "yes" ? 1
        : tags.oneway === "-1" ? -1
        : 0,
      ...(tags.website ? { website: tags.website } : undefined),
      ...(tags.opening_date ? { opening_date: tags.opening_date } : undefined),
    };
  } else if (
    tags.highway
    && tags.oneway !== "yes"
    && (tags.cycleway === "lane"
      || tags["cycleway:both"] === "lane"
      || (tags["cycleway:left"] === "lane"
        && tags["cycleway:right"] === "lane"))
  ) {
    // A road with regular bike *lanes* that lie on within the roadway itself, one on each side.
    let dooringRisk = false;
    // Check for dooring risk:
    if (
      tagIsOneOf(tags.parking, "lane", "street_side")
      || tagIsOneOf(tags["parking:both"], "lane", "street_side")
    ) {
      // TODO: should we ignore if "parking:[side]:orientation" is "diagonal" or "perpendicular" ?
      dooringRisk = true;
    } else if (tags["parking:both"] === "separate") {
      // The parking is a separate OSM way, so theoretically we'd need to implement
      // preprocessOsmWay() to create a list of nearby parking areas first similar to
      // https://github.com/onthegomap/planetiler/discussions/1071#discussioncomment-10988131
      // to identify the specific parking area and check if it has orientation=parallel and
      // parking=street_side or parking=lane... but so far I've only found a few instances
      // of this alongside bike lanes in BC and they're all dooring risks (no false
      // positives we need to filter out).
      dooringRisk = true;
    } else if (
      tagIsOneOf(tags["parking:right"], "separate", "lane", "street_side")
      || tagIsOneOf(tags["parking:right"], "separate", "lane", "street_side")
    ) {
      // This is a complex case that we don't yet handle well - the bike lane in one direction
      // is fine, but in the other direction has a dooring risk. So since we're only showing
      // one line for both directions, we downgrade this whole segment of the route.
      // Also see note above about how "separate" might need to be further filtered.
      dooringRisk = true;
    }

    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
      comfort: dooringRisk ? CyclingComfort.LEAST : CyclingComfort.LOW,
      oneway: 0,
      ...(dooringRisk ? { dooring_risk: true } : undefined),
    };
  } else if (
    tags.highway
    && tags.oneway !== "yes"
    && ((tags["cycleway:right"] === "lane"
      && tags["cycleway:right:oneway"] === "no")
      || (tags["cycleway:left"] === "lane"
        && tags["cycleway:left:oneway"] === "no"))
  ) {
    // A two-way bike lane on one side of the roadway, not separated from traffic
    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
      comfort: CyclingComfort.LOW,
      oneway: 0,
      side: tags["cycleway:right"] === "lane" ? "right" : "left",
    };
  } else if (
    tags.highway
    && tags.oneway === "yes"
    && (tags.cycleway === "lane"
      || tags["cycleway:right"] === "lane"
      || tags["cycleway:left"] === "lane")
  ) {
    // A one-way bike lane on a one-way roadway, not separated from traffic
    const side = tags["cycleway:left"] === "lane" ? "left" : "right";
    let dooringRisk = false;
    if (
      tagIsOneOf(tags[`parking:${side}`], "separate", "lane", "street_side")
    ) {
      // The bike lane is adjacent to parking
      // TODO: need some way to negate this if there is a buffer between the bike lane and
      // the parking lane. But https://wiki.openstreetmap.org/wiki/Key:cycleway:buffer is
      // explicitly only for a buffer between the bike lane and cars.
      // Can possibly use "cycleway:right:separation:right" etc. per
      // https://wiki.openstreetmap.org/wiki/Proposal:Separation but this doesn't have
      // much adoption.
      // Also see note above about how "separate" might need to be further filtered.
      dooringRisk = true;
    }
    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
      comfort: dooringRisk ? CyclingComfort.LEAST : CyclingComfort.LOW,
      // Default is one way like the "parent" roadway
      oneway:
        // In rare cases, there is a bike lane on both sides of a one way street.
        // In even rarer cases, there is some other exotic lane type on one side, but we ignore that for now.
        tags["cycleway:right"] === "lane" && tags["cycleway:left"] === "lane" ?
          0
        : (
          tags["cycleway:left"] === "lane" && tags["cycleway:right"] === "lane"
        ) ?
          0
        : 1,
      side,
      ...(dooringRisk ? { dooring_risk: true } : undefined),
    };
  } else if (
    (tags.highway && tagIsOneOf(tags.cycleway, "shared_lane", "shared"))
    || tagIsOneOf(tags["cycleway:both"], "shared_lane", "shared")
  ) {
    // A lane that is shared with motor vehicles
    let maxSpeed = safeParseInt(tags.maxspeed);

    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
      comfort:
        tags.motor_vehicle === "private" ? CyclingComfort.HIGH
        : maxSpeed && maxSpeed <= 30 ? CyclingComfort.HIGH
        : CyclingComfort.LEAST,
      oneway:
        tags["oneway:bicycle"] === "no" ? 0
        : tags.oneway === "yes" ? 1
        : 0,
    };
  } else if (
    tags.highway === "residential"
    && tagIsOneOf(tags.bicycle, "yes", "designated")
    && safeParseInt(tags.maxspeed) !== undefined
    && safeParseInt(tags.maxspeed)! <= 30
  ) {
    // A slow street that bicycles can use
    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: tags.foot === "yes",
      shared_with_vehicles: true,
      comfort: CyclingComfort.HIGH,
      oneway:
        tags["oneway:bicycle"] === "no" ? 0
        : tags.oneway === "yes" ? 1
        : 0,
    };
  } else if (
    tags.highway
    && ((tags["cycleway:right"] === "lane" && tags["cycleway:left"] === "no")
      || (tags["cycleway:left"] === "lane" && tags["cycleway:right"] === "no"))
  ) {
    // The street is a two-way street but the bike lane is a one-way bike lane on one side only.
    // "L2" on https://wiki.openstreetmap.org/wiki/Bicycle (highway=* + cycleway:right=lane)
    const side = tags["cycleway:left"] === "lane" ? "left" : "right";
    let dooringRisk = false;
    if (
      tagIsOneOf(tags["parking:both"], "separate", "lane", "street_side")
      || tagIsOneOf(tags[`parking:${side}`], "separate", "lane", "street_side")
    ) {
      dooringRisk = true;
    }
    return {
      ...common,
      class: "lane",
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
      comfort: dooringRisk ? CyclingComfort.LEAST : CyclingComfort.LOW,
      oneway: tags["cycleway:left"] === "lane" ? -1 : 1,
      side,
      ...(dooringRisk ? { dooring_risk: true } : undefined),
    };
  }
  // TODO: support other types of cycle paths
  // TODO: support "T2 (alternative)" on https://wiki.openstreetmap.org/wiki/Bicycle (cycleway:right=track + cycleway:right:oneway=no)
  // e.g. https://www.openstreetmap.org/way/74096518 (mixed lane + shared_lane)
}
