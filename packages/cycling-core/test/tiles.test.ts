import { describe, expect, it } from "vitest";
import { CyclingNetworkBuilder } from "../src/network.ts";
import { parseOpl } from "../src/osm.ts";
import {
  CYCLING_DETAIL_ZOOM,
  CYCLING_LAYER,
  cyclingTileFeatures,
  osmFeatureId,
} from "../src/tiles.ts";

/** The network from OPL lines. */
function network(lines: string[]) {
  const b = new CyclingNetworkBuilder({ calmMaxSpeedKmh: 30 });
  for (const l of lines) b.add(parseOpl(l)!);
  return b.build();
}

// Two cycleway ways end to end (about 1.1 km each), part of one bike route, and bike parking.
const OPL = [
  "n100 Tamenity=bicycle_parking,name=Rack x-123.1 y49.25",
  "w10 Thighway=cycleway,name=Seaside,surface=asphalt Nn1x-123.10y49.25,n2x-123.10y49.26",
  "w11 Thighway=cycleway,name=Seaside,surface=asphalt Nn2x-123.10y49.26,n3x-123.10y49.27",
  "w12 Thighway=residential Nn3x-123.10y49.27,n4x-123.11y49.27",
  "w20 Tamenity=bicycle_parking Nn5x0y0,n6x1y0,n7x1y1,n8x0y1,n5x0y0",
  "r30 Ttype=route,route=bicycle Mw10@,w11@,w11@",
];

describe("CyclingNetworkBuilder", () => {
  it("keeps cycling ways with their routes, and bike parking", () => {
    const n = network(OPL);
    expect(n.ways.map((w) => w.id)).toEqual([10, 11]);
    expect(n.ways[0]!.attrs).toMatchObject({
      name: "Seaside",
      surface: "asphalt",
      routes: "30",
    });
    expect(n.parking).toEqual([
      {
        lonLat: [-123.1, 49.25],
        properties: {
          amenity: "bicycle_parking",
          name: "Rack",
          osmNodeId: 100,
        },
      },
      {
        lonLat: [0.5, 0.5],
        properties: { amenity: "bicycle_parking", osmWayId: 20 },
      },
    ]);
  });
});

describe("cyclingTileFeatures", () => {
  const n = network(OPL);
  const features = [...cyclingTileFeatures(n.ways, n.parking)];
  const lines = features.filter((f) => f.geometry.type === "LineString");

  it("has whole chains with every attribute and an id from the detail zoom", () => {
    const detail = lines.filter(
      (f) => f.tippecanoe.minzoom === CYCLING_DETAIL_ZOOM,
    );
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({
      id: osmFeatureId("way", 10),
      properties: { name: "Seaside", surface: "asphalt", routes: "30" },
      tippecanoe: { layer: CYCLING_LAYER },
    });
  });

  it("has the chain below it without ids or details, from the zoom it's a pixel long", () => {
    const overview = lines.filter(
      (f) => f.tippecanoe.minzoom! < CYCLING_DETAIL_ZOOM,
    );
    // Each way is ~1.1 km: under a pixel at z6 (~1.6 km at 49°), so from z7.
    expect(overview.map((f) => f.tippecanoe.minzoom)).toEqual([
      7, 8, 9, 10, 11, 12,
    ]);
    for (const f of overview) {
      expect(f.id).toBeUndefined();
      expect(f.properties).not.toHaveProperty("name");
      expect(f.properties).not.toHaveProperty("routes");
      expect(f.tippecanoe.maxzoom).toBe(f.tippecanoe.minzoom);
    }
  });

  it("gives bike parking ids that can't collide with paths'", () => {
    expect(
      features.filter((f) => f.geometry.type === "Point").map((f) => f.id),
    ).toEqual([osmFeatureId("node", 100), osmFeatureId("way", 20)]);
    expect(osmFeatureId("node", 100)).not.toBe(osmFeatureId("way", 100));
  });
});
