/**
 * This file defines all the possible values of OpenStreetMap feature
 * tags that we may encounter, in the simplest terms. It defines the
 * common, known values and also clarifies that there may be unexpected
 * values for any given key ("string" type).
 *
 * This is purely a type-checking feature and has NO runtime code.
 */

/* Generic placeholder for any value type we're not expecting */
type OtherValueStr = string & { __brand: "Other Value" };
type NumericValue = `${number}`;
type BoolStr = "yes" | "no";

type CyclewayValues =
  | "no"
  | "lane"
  | "crossing"
  | "shared_lane"
  | "share_busway"
  | "track"
  | "separate"
  | OtherValueStr;
type ParkingValues =
  | "yes"
  | "no"
  | "lane"
  | "street_side"
  | "separate"
  | "half_on_kerb"
  | "on_kerb"
  | "no_parking"
  | "parallel"
  | "shoulder"
  | OtherValueStr;

export interface OsmTagRecord {
  /**
   * `bicycle` specifies legal restriction for cyclists when used on roads and paths.
   * https://wiki.openstreetmap.org/wiki/Key:bicycle
   */
  bicycle?:
    | BoolStr
    | "designated"
    | "use_sidepath"
    | "dismount"
    | "permissive"
    | "private"
    | OtherValueStr;
  /**
   * Clarifies which part of the feature is under construction
   * https://wiki.openstreetmap.org/wiki/Key:construction
   */
  construction?:
    | "yes"
    | "residential"
    | "house"
    | "motorway"
    | "minor"
    | "rail"
    | "service"
    | "motorway_link"
    | "tertiary"
    | "apartments"
    | "secondary"
    | "trunk"
    | "footway"
    | "primary"
    | "unclassified"
    | "building"
    | "shed"
    | "industrial"
    | "cycleway"
    | "path"
    | "subway"
    | OtherValueStr;
  /**
   * Describes cycling infrastructure that is an inherent part of the road,
   * usually bike lanes that are part of the road, directly alongside traffic.
   * https://wiki.openstreetmap.org/wiki/Key:cycleway
   */
  cycleway?: CyclewayValues;
  "cycleway:both"?: CyclewayValues;
  "cycleway:left"?: CyclewayValues;
  "cycleway:left:oneway"?: "yes" | "no" | "-1" | OtherValueStr;
  "cycleway:right"?: CyclewayValues;
  "cycleway:right:oneway"?: "yes" | "no" | "-1" | OtherValueStr;
  /**
   * Legal access restriction for pedestrians when used on roads and paths.
   * https://wiki.openstreetmap.org/wiki/Key:foot
   */
  foot?:
    | BoolStr
    | "designated"
    | "permissive"
    | "use_sidepath"
    | "private"
    | OtherValueStr;
  /**
   * `highway=*` is the main key used for identifying any kind of road, street or path.
   * https://wiki.openstreetmap.org/wiki/Key:highway
   */
  highway?:
    | "residential"
    | "service"
    | "track"
    | "footway"
    | "unclassified"
    | "path"
    | "crossing"
    | "tertiary"
    | "secondary"
    | "pedestrian"
    | "cycleway"
    | "construction"
    | OtherValueStr;
  /**
   * Total number of traffic lanes available for motorised traffic.
   * https://wiki.openstreetmap.org/wiki/Key:lanes
   */
  lanes?: NumericValue | OtherValueStr;
  /**
   * Maximum speed (speed limit), in km/h unless a unit is given.
   * https://wiki.openstreetmap.org/wiki/Key:maxspeed
   */
  maxspeed?: `${number}` | `${number} ${string}` | "none" | OtherValueStr;
  /**
   * Access restrictions for motor vehicles
   * https://wiki.openstreetmap.org/wiki/Key:motor_vehicle
   */
  motor_vehicle?:
    | "no"
    | "yes"
    | "private"
    | "destination"
    | "agricultural"
    | "forestry"
    | "designated"
    | "permit"
    | "permissive"
    | OtherValueStr;
  /**
   * This key is set to the primary name of the feature in the real world.
   * https://wiki.openstreetmap.org/wiki/Key:name
   */
  name?: string;
  /**
   * Linear features that users can only go one direction in.
   * https://wiki.openstreetmap.org/wiki/Key:oneway
   */
  oneway?: BoolStr | "-1" | OtherValueStr;
  "oneway:bicycle"?: BoolStr | "-1" | OtherValueStr;
  /**
   * When a feature under construction will be opened.
   * Should be in `YYYY-MM-DD` format.
   * https://wiki.openstreetmap.org/wiki/Key:opening_date
   */
  opening_date?: string;
  /**
   * What kind of parking is available. Generally prefer `parking:both`,
   * `parking:left`, or `parking:right`.
   * https://wiki.openstreetmap.org/wiki/Key:parking
   */
  parking?: ParkingValues;
  "parking:both"?: ParkingValues;
  "parking:left"?: ParkingValues;
  "parking:right"?: ParkingValues;
  /**
   * `segregated` describes designated combined cycle- and footways.
   * If both have their own lane, `segregated=yes`.
   * If they share one lane, `segregated=no`.
   * https://wiki.openstreetmap.org/wiki/Key:segregated
   */
  segregated?: BoolStr | OtherValueStr;
  /**
   * Describes the surface of a feature (paved, dirt, etc.).
   * https://wiki.openstreetmap.org/wiki/Key:surface
   */
  surface?:
    | "paved"
    | "unpaved"
    | "asphalt"
    | "concrete"
    | "paving_stones"
    | "ground"
    | "gravel"
    | "dirt"
    | "grass"
    | "compacted"
    | "sand"
    | "sett"
    | "fine_gravel"
    | "wood"
    | OtherValueStr;
  /**
   * Official website with information about a feature.
   * https://wiki.openstreetmap.org/wiki/Key:website
   */
  website?: string;
}
