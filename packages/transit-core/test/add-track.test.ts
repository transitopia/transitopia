import { describe, expect, it } from "vitest";
import { TrackGraph } from "../src/infra/graph.ts";
import { addTrack } from "../src/infra/compose.ts";
import type {
  InfraCollection,
  InfraFeature,
  NodeKind,
  SegmentEnd,
} from "../src/infra/types.ts";
import type { LonLat } from "../src/geo.ts";

const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [
  Math.round((-123 + x / M_PER_DEG_LON) * 1e7) / 1e7,
  Math.round((49.25 + y / 110_574) * 1e7) / 1e7,
];
const node = (
  id: string,
  kind: NodeKind,
  at: LonLat,
  turns: [SegmentEnd, SegmentEnd][] = [],
): InfraFeature => ({
  type: "Feature",
  properties: { type: "node", id, kind, turns, osmNode: 0 },
  geometry: { type: "Point", coordinates: at },
});
// Base: one 1 km track ending at a buffer.
const base: InfraCollection = {
  type: "FeatureCollection",
  metadata: { source: "test", generatedAt: "" },
  features: [
    {
      type: "Feature",
      properties: {
        type: "segment",
        id: "s",
        kind: "main",
        lines: ["millennium"],
        from: "a",
        to: "b",
        length: 1000,
        osmWay: 7,
      },
      geometry: { type: "LineString", coordinates: [pt(0), pt(500), pt(1000)] },
    },
    node("a", "buffer", pt(0)),
    node("b", "buffer", pt(1000)),
  ],
};

describe("addTrack", () => {
  it("joins added track at an existing buffer and lets trains run through", () => {
    const added: GeoJSON.FeatureCollection<
      GeoJSON.LineString,
      { kind?: "main"; lines?: ["millennium"] }
    > = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { lines: ["millennium"] },
          geometry: { type: "LineString", coordinates: [pt(1001), pt(2000)] },
        },
      ],
    };
    const { fc, stats } = addTrack(base, added);
    expect(stats.addedTracks).toBe(1);
    const g = TrackGraph.fromCollection(fc);
    const start = g.nearest(pt(100), 5)[0]!;
    const end = g.nearest(pt(1900), 5)[0]!;
    const r = g.route(start, end, { allowReversals: false });
    expect(r).not.toBeNull();
    expect(r!.length).toBeCloseTo(1800, -1);
  });
});
