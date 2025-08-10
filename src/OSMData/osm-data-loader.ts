import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import * as z from "zod";
import { osmFeatureSchema, OsmFeatureType } from "./osm-types";

/**
 * The API endpoint for the Overpass API server that we're using.
 * Overpass is a read-only optimized API for querying OpenStreetMap data.
 */
const overpassEndpoint = "https://overpass-api.de/api/interpreter";

class OsmEntityNotFound extends Error {}

/**
 * "Raw" data about an OSM node (a point), as returned from the Overpass API
 * or our `useOsmNode` function.
 */
export interface RawOsmNode {
    type: "node";
    id: number;
    lat: number;
    lon: number;
    tags: Record<string, string>;
}

/**
 * Hook to get data from an OpenStreetMap node
 * e.g. https://www.openstreetmap.org/node/5324432722
 * 
 * Warning: Nodes, Way, and Relations each have their own ID space,
 * so the same ID can exist as a (totally unrelated) node, way, and/or relation.
 */
export function useOsmNode<Schema extends z.ZodType>(nodeId: number | undefined, schema: Schema): UseQueryResult<z.output<Schema>, Error> {
    return useQuery({
        queryKey: ["osmNode", nodeId],
        queryFn: async () => {
            const result = await fetch(overpassEndpoint, {
                method: "POST",
                body: "data="+ encodeURIComponent(`[out:json][timeout:10]; node(${nodeId}); out;`),
            });
            const fullData = await result.json();
            if (fullData.elements.length !== 1) {
                throw new OsmEntityNotFound();
            }
            const nodeData = fullData.elements[0] as RawOsmNode;
            const parsed = schema.parse({
                ...nodeData.tags,
                featureType: OsmFeatureType.Node,
                osmId: nodeId,
            }) as Record<string, unknown>;
            // All schemas MUST also match 'osmFeatureSchema':
            osmFeatureSchema.parse(parsed);
            // For any tags that didn't match the schema or weren't expected, put them in 'otherTags'
            return {...parsed, otherTags: Object.fromEntries(Object.entries(nodeData.tags).filter(([k]) => !(k in parsed)))} as any;
        },
        enabled: nodeId !== undefined,
    });
}
