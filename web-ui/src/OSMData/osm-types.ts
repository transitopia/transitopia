import * as z from "zod";

export const OsmFeatureType = {
  Node: "node",
  Way: "way",
  Relation: "relation",
} as const;
export type OsmFeatureType = typeof OsmFeatureType[keyof typeof OsmFeatureType];

/**
 * Base schema for information about any OpenStreetMap feature
 */
export const osmFeatureSchema = z.object({
  /** Transitopia-specific identifier for this feature type */
  type: z.string().default("osmNode"),
  /** Is this a node, a way, or a relation? */
  featureType: z.literal([
    OsmFeatureType.Node,
    OsmFeatureType.Way,
    OsmFeatureType.Relation,
  ]),
  /** The ID on OpenStreetMap. Only unique if used together with `featureType`! */
  osmId: z.number(),
  /** tags that weren't parsed by the particular schema we're using */
  otherTags: z.record(z.string(), z.string()).optional(),
  // TODO: add common tags like:
  // https://wiki.openstreetmap.org/wiki/Photo_linking to all features
});
