/**
 * Our overly-complicated FeatureId format.
 *
 * A FeatureId is a unique Identifier for anything that can appear on the map,
 * and perhaps even abstract things like "schedules" that can't exactly be mapped
 * but are nevertheless part of Transitopia.
 *
 * The basic format of a FeatureId is designed to exaclty match what users see in
 * the URL, e.g.
 *    cycling/way/123890
 * for a bike lane, which would be accessed at https://www.transitopia.org/cycling/way/123890
 *
 * The main thing about FeatureIds is that we always try to just re-use the "main"
 * external identifier. So for bike lanes, we always use the OpenStreetMap "way" ID
 * and so on.
 *
 * However, sometimes we need to namespace our IDs. For example, bike parking spaces
 * come primarily from OpenStreetMap, but there are separate namespaces for them:
 * "node" bike parking spaces and "way" bike parking areas. Because the ID numbers
 * are only unique within each namespace, we have to distinguish them like this:
 *    cycling/parking/node:123890
 *    cycling/parking/way:123890   (a totally different bike parking area)
 *
 * And then, we may in the future have data coming in from other sources than the
 * "main" source for a given type, so we support a "source" prefix like this:
 *    cycling/station/gbfs:vancouver:123325
 *    cycling/station/other_source:vancouver:acbdef
 *
 * So the full breakdown is:
 *    domain/type/source:namespace:identifier
 *
 * Where source and/or namespace are often optional, depending on the domain+type.
 * If source is included, namespace is always required.
 */
import * as z from "zod";

export const FeatureDomain = {
  /** Cycling and micromobility */
  Cycling: "cycling",
  /** Public Transit */
  Transit: "transit",
} as const;
const FeatureDomainEnum = z.enum(FeatureDomain);
export type FeatureDomain = z.infer<typeof FeatureDomainEnum>;

/** The meaning of these feature types depends on the domain */
export const FeatureType = {
  Way: "way",
  Parking: "parking",
  Route: "route",
  Station: "station",
  Bike: "bike",
} as const;
const FeatureTypeEnum = z.enum(FeatureType);
export type FeatureType = z.infer<typeof FeatureTypeEnum>;

export const FeatureSource = {
  /** OpenStreetMap */
  Osm: "osm",
  /** General Transit Feed Specification */
  Gtfs: "gtfs",
  /** General Bikeshare Feed Specification  */
  Gbfs: "gbfs",
} as const;
const FeatureSourceEnum = z.enum(FeatureSource);
export type FeatureSource = z.infer<typeof FeatureSourceEnum>;

/** The three types of features used on OpenStreetMap: Node, Way, and Relation */
export const OsmFeatureNamespace = {
  Node: "node",
  Way: "way",
  Relation: "relation",
} as const;
const OsmFeatureNamespaceEnum = z.enum(OsmFeatureNamespace);
export type OsmFeatureNamespace = z.infer<typeof OsmFeatureNamespaceEnum>;

/** A bike lane / bike track */
const CyclingWayId = z.object({
  domain: z.literal(FeatureDomain.Cycling),
  type: z.literal(FeatureType.Way),
  source: z.literal(FeatureSource.Osm).default(FeatureSource.Osm),
  namespace: z
    .literal(OsmFeatureNamespace.Way)
    .default(OsmFeatureNamespace.Way),
  identifier: z.string().regex(/^\d+$/),
});
export type CyclingWayId = z.infer<typeof CyclingWayId>;

/** A bike parking spot */
const BicycleParkingId = z.object({
  domain: z.literal(FeatureDomain.Cycling),
  type: z.literal(FeatureType.Parking),
  source: z.literal(FeatureSource.Osm).default(FeatureSource.Osm),
  namespace: z.union([
    z.literal(OsmFeatureNamespace.Node),
    z.literal(OsmFeatureNamespace.Way),
  ]),
  identifier: z.string().regex(/^\d+$/),
});
export type BicycleParkingId = z.infer<typeof BicycleParkingId>;

/** A bike route, e.g. "Central Valley Greenway" - a path made of many CyclingWay segments */
const CyclingRouteId = z.object({
  domain: z.literal(FeatureDomain.Cycling),
  type: z.literal(FeatureType.Route),
  source: z.literal(FeatureSource.Osm).default(FeatureSource.Osm),
  namespace: z
    .literal(OsmFeatureNamespace.Relation)
    .default(OsmFeatureNamespace.Relation),
  identifier: z.string().regex(/^\d+$/),
});
export type CyclingRouteId = z.infer<typeof CyclingRouteId>;

const CyclingFeatureId = z.discriminatedUnion("type", [
  CyclingWayId,
  CyclingRouteId,
  BicycleParkingId,
]);

const TransitRouteId = z.object({
  domain: z.literal(FeatureDomain.Transit),
  type: z.literal(FeatureType.Route),
  source: z.literal(FeatureSource.Gtfs).default(FeatureSource.Gtfs),
  namespace: z.string(),
  identifier: z.string().regex(/^\d+$/),
});
const TransitStationId = z.object({
  domain: z.literal(FeatureDomain.Transit),
  type: z.literal(FeatureType.Station),
  source: z.literal(FeatureSource.Gtfs).default(FeatureSource.Gtfs),
  namespace: z.string(),
  identifier: z.string().regex(/^\d+$/),
});

const TransitFeatureId = z.discriminatedUnion("type", [
  TransitRouteId,
  TransitStationId,
]);

export const FeatureId = z.discriminatedUnion("domain", [
  CyclingFeatureId,
  TransitFeatureId,
]);
export type FeatureId = z.infer<typeof FeatureId>;

// Make parseIdString() return a specific FeatureId subclass if it can
export function parseIdString<
  D extends FeatureDomain = FeatureDomain,
  T extends FeatureType = FeatureType,
>(idStr: `${D}/${T}/${string}`): FeatureId & { domain: D; type: T };

export function parseIdString(idStr: string): FeatureId;

export function parseIdString(idStr: string) {
  const [domain, type, sourceNamespaceIdentifier, ...rest] = idStr.split("/");
  if (rest.length !== 0) {
    throw new Error(`Invalid ID "${idStr}": unexpected "/"`);
  }
  const [first, second, ...idParts] = sourceNamespaceIdentifier.split(":");
  let source: string | undefined,
    namespace: string | undefined,
    identifier: string | undefined;
  if (idParts.length > 0) {
    source = first;
    namespace = second;
    identifier = idParts.join(":");
  } else if (second !== undefined) {
    namespace = first;
    identifier = second;
  } else {
    identifier = first;
  }
  return FeatureId.parse({
    domain,
    type,
    source,
    namespace,
    identifier,
    // deno-lint-ignore no-explicit-any
  }) as any;
}
