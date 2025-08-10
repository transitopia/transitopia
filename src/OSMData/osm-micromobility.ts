import * as z from "zod";
import { osmFeatureSchema, OsmFeatureType } from "./osm-types";
import { removeUndefinedKeys } from "./utils";

/**
 * Bike racks or any other "parking space designed for bicycles, where one can leave a pedal cycle unattended in reasonable security"
 * https://wiki.openstreetmap.org/wiki/Tag:amenity%253Dbicycle_parking
 */
export const bikeParkingSchema = z.object({
    ...osmFeatureSchema.shape,
    /** Transitopia-specific "type" key. */
    type: z.literal("bike_parking").default("bike_parking"),
    /** The upstream feature MUST have this tag `amenity=bicycle_parking` */
    amenity: z.literal("bicycle_parking"),
    /** Bike racks / bike parking locations can be a point (node) or a larger area (way). */
    featureType: z.literal([OsmFeatureType.Node, OsmFeatureType.Way]),
    /**
     * What type of bike rack / bike parking this is.
     * https://wiki.openstreetmap.org/wiki/Key:bicycle_parking
     */
    bicycleParkingType: z.literal([
        "stands",
        "wall_loops",
        "rack",
        "shed",
        "bollard",
        "wide_stands",
        "building",
        "lockers",
        "wave",
        "anchors",
        "floor",
        "safe_loops",
        "ground_slots",
        "handlebar_holder",
        "informal",
        "two-tier",
        "streetpod",
        "lean_and_stick",
        "upright_stands",
        "tree",
        "saddle_holder",
        "crossbar",
        "rope",
        "arcadia",
        "log_with_slots",
    ]).optional().catch(undefined),
    name: z.string().optional(),
    /**
     * Company/organization that operates this bike parking facility, e.g. `Lime`
     * https://wiki.openstreetmap.org/wiki/Key:operator
     */
    operator: z.string().optional(),
    /**
     * Identifies the exact operator, e.g. `Q39086685` for Lime
     * https://wiki.openstreetmap.org/wiki/Key:operator:wikidata
     */
    "operator:wikidata": z.string().optional(),
    /**
     * Is this bike parking indoors?
     * boolean, based on OSM values like `yes`, `no`, `room`, `area`, `wall`.
     * https://wiki.openstreetmap.org/wiki/Key:indoor
     */
    indoor: z.transform(x => (x && x !== "no" ) ? true : (x == "no" ? false : undefined)).optional(),
    /**
     * "The total number of bikes that can be parked here. Please note that many stands are two-sided and can hold up to two bicycles for each stand."
     */
    capacity: z.coerce.number().optional().catch(undefined),
    /**
     * Is this covered?
     * boolean, based on OSM values like `yes`, `no`, `partial` (becomes `yes`)
     */
    covered: z.transform(x => (x && x !== "no" ) ? true : (x == "no" ? false : undefined)).optional(),
   // Potentially add: access=*, capacity:cargo_bike=*, cargo_bike=*, fee=*
}).transform(removeUndefinedKeys);

export type BikeParkingFeature = z.infer<typeof bikeParkingSchema>;
