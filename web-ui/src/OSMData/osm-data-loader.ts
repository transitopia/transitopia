import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import * as z from "zod";
import { osmFeatureSchema, OsmFeatureType } from "./osm-types.ts";

/**
 * The API endpoint for the Overpass API server that we're using.
 * Overpass is a read-only optimized API for querying OpenStreetMap data.
 */
const overpassEndpoint = "https://overpass-api.de/api/interpreter";

class OsmEntityNotFound extends Error {}

/**
 * "Raw" data about an OSM node (a point), as returned from the Overpass API.
 */
interface RawOsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

/**
 * "Raw" data about an OSM way (a line or area), as returned from the Overpass API.
 */
interface RawOsmWay {
  type: "way";
  id: number;
  nodes: number[]; // Note: it's possible to ask the API to give these recursively so we get the coordinates and not just the IDs, but we haven't needed that yet.
  tags: Record<string, string>;
}

/**
 * "Raw" data about an OSM relation, as returned from the Overpass API.
 */
interface RawOsmRelation {
  type: "relation";
  id: number;
  members: { type: "way" | "node" | "relation"; ref: number; role: string };
  tags: Record<string, string>;
}

type RawOsmFeature = RawOsmNode | RawOsmWay | RawOsmRelation;

/**
 * Hook to get data from an OpenStreetMap node/way/relation
 * e.g. https://www.openstreetmap.org/node/5324432722
 * e.g. https://www.openstreetmap.org/way/697625710
 * e.g. https://www.openstreetmap.org/relation/7882446
 *
 * Warning: Nodes, Way, and Relations each have their own ID space,
 * so the same ID can exist as a (totally unrelated) node, way, and/or relation.
 */
export function useOsmFeature<Schema extends z.ZodType>(
  featureType: OsmFeatureType | undefined,
  id: number | undefined,
  schema: Schema,
): UseQueryResult<z.output<Schema>, Error> {
  return useQuery({
    queryKey: ["osmFeature", featureType, id],
    queryFn: async () => {
      const response = await fetch(overpassEndpoint, {
        method: "POST",
        body: "data=" +
          encodeURIComponent(
            `[out:json][timeout:10]; ${featureType}(${id}); out;`,
          ),
      });
      const fullData = await response.json();
      if (fullData.elements.length !== 1) {
        throw new OsmEntityNotFound();
      }
      const nodeData = fullData.elements[0] as RawOsmFeature;
      const parsed = schema.parse({
        ...nodeData.tags,
        featureType,
        osmId: id,
        ...(nodeData.type === "way" ? nodeData.nodes : undefined),
        ...(nodeData.type === "relation" ? nodeData.members : undefined),
      }) as Record<string, unknown>;
      // For any tags that didn't match the schema or weren't expected, put them in 'otherTags'
      const result = {
        ...parsed,
        otherTags: Object.fromEntries(
          Object.entries(nodeData.tags).filter(([k]) => !(k in parsed)),
        ),
        // deno-lint-ignore no-explicit-any
      } as any;
      // All schemas MUST also match 'osmFeatureSchema':
      osmFeatureSchema.parse(result);
      return result;
    },
    enabled: featureType !== undefined && id !== undefined,
  });
}
