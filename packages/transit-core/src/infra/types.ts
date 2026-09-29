// Track infrastructure model (docs/skytrain-viz-PLAN.md §4.1). Stored as GeoJSON so it opens in geojson.io / QGIS:
// LineString features are track segments, Point features are nodes (with their allowed turns) and
// OSM stop positions. Built by pipelines/import-osm.ts; hand fixes live in overrides.json.

import type { LonLat } from "../geo.ts";

export type SegmentKind =
  "main" | "pocket" | "tail" | "siding" | "crossover" | "spur" | "yard";
export type NodeKind = "switch" | "buffer" | "end" | "crossing" | "link";
export type LineKey = "expo" | "millennium" | "canada";

/** A segment end: `${segmentId}:0` is its start (first coordinate), `${segmentId}:1` its end. */
export type SegmentEnd = `${string}:${0 | 1}`;

export interface SegmentProps {
  type: "segment";
  id: string;
  kind: SegmentKind;
  /** Lines using (or nearest to) this track, for colouring. Empty for yards. */
  lines: LineKey[];
  from: string;
  to: string;
  length: number;
  name?: string;
  trackRef?: string;
  maxspeed?: number;
  layer?: number;
  bridge?: boolean;
  tunnel?: boolean;
  /** OSM tags this in-service track as under construction or disused (see import-osm.ts). */
  works?: boolean;
  osmWay: number;
}

export interface NodeProps {
  type: "node";
  id: string;
  kind: NodeKind;
  /** Pairs of segment ends a train may pass between at this node. */
  turns: [SegmentEnd, SegmentEnd][];
  osmNode: number;
}

export interface StopPositionProps {
  type: "stop";
  name: string;
  /** OSM railway:ref, e.g. "VCI"/"VCO" (station code + inbound/outbound). */
  railwayRef?: string;
  segment: string;
  offset: number;
  osmNode: number;
}

export type InfraFeature =
  | GeoJSON.Feature<GeoJSON.LineString, SegmentProps>
  | GeoJSON.Feature<GeoJSON.Point, NodeProps>
  | GeoJSON.Feature<GeoJSON.Point, StopPositionProps>;

export interface InfraCollection {
  type: "FeatureCollection";
  metadata: {
    source: string;
    osmTimestamp?: string;
    generatedAt: string;
    note?: string;
  };
  features: InfraFeature[];
}

export interface Segment extends Omit<SegmentProps, "type"> {
  coords: LonLat[];
  cum: Float64Array;
}

export interface TrackNode extends Omit<NodeProps, "type"> {
  lon: number;
  lat: number;
}

export interface StopPosition extends Omit<StopPositionProps, "type"> {
  lon: number;
  lat: number;
}
