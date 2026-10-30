import type { LineString } from "geojson";
import { describe, expect, it } from "vitest";
import { CyclingNetworkBuilder } from "../src/network.ts";
import { parseOpl } from "../src/osm.ts";
import {
  CYCLING_DETAIL_ZOOM,
  CYCLING_LAYER,
  CYCLING_MIN_ZOOM,
  CYCLING_ROUTES_LAYER,
  CYCLING_ROUTES_MAX_ZOOM,
  cyclingRouteTileFeatures,
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

  it("keeps bike parking's details", () => {
    const n = network([
      "n1 Tamenity=bicycle_parking,bicycle_parking=wall_loops,capacity=12,covered=partial,indoor=no,operator=City x0 y0",
      "n2 Tamenity=bicycle_parking,capacity=~10 x0 y0",
    ]);
    expect(n.parking.map((p) => p.properties)).toEqual([
      {
        amenity: "bicycle_parking",
        bicycle_parking: "wall_loops",
        capacity: 12,
        covered: true,
        indoor: false,
        operator: "City",
        osmNodeId: 1,
      },
      { amenity: "bicycle_parking", osmNodeId: 2 },
    ]);
  });

  it("summarises bike routes: their ways and their subroutes', each once", () => {
    const n = network([
      ...OPL,
      "r31 Ttype=route,route=bicycle,name=Greenway,network=rcn,ref=GW Mr30@,w12@,w10@,r99@",
      "r32 Ttype=route,route=bicycle Mw404@",
    ]);
    const r30 = n.routes.get(30)!;
    const r31 = n.routes.get(31)!;
    const r32 = n.routes.get(32)!;
    // w10 and w11, about 1.1 km each; w12, about 0.7 km at 49°.
    expect(r30.lengthM).toBeGreaterThan(2200);
    expect(r30.lengthM).toBeLessThan(2250);
    expect(r30.bbox).toEqual([-123.1, 49.25, -123.1, 49.27]);
    expect(r31).toMatchObject({
      name: "Greenway",
      network: "rcn",
      ref: "GW",
      subroutes: [30],
      bbox: [-123.11, 49.25, -123.1, 49.27],
    });
    expect(r31.lengthM - r30.lengthM).toBeGreaterThan(700);
    expect(r31.lengthM - r30.lengthM).toBeLessThan(750);
    expect(r30.parents).toEqual([31]);
    expect(r31.parents).toBeUndefined();
    expect(r32).toEqual({ lengthM: 0, comfortM: [0, 0, 0, 0, 0] });
    expect([...n.routes.keys()]).toEqual([30, 31, 32]);
  });

  it("measures a route by the comfort of each way, 0 where there's no bike facility", () => {
    const n = network([...OPL, "r31 Ttype=route,route=bicycle Mr30@,w12@"]);
    const { comfortM, lengthM } = n.routes.get(31)!;
    // w10 and w11 are cycleways (comfort 4); w12 is a residential street with no facility.
    expect(comfortM[4]).toBe(n.routes.get(30)!.lengthM);
    expect(comfortM[0]).toBeGreaterThan(700);
    expect(comfortM[1] + comfortM[2] + comfortM[3]).toBe(0);
    expect(
      Math.abs(comfortM.reduce((a, b) => a + b) - lengthM),
    ).toBeLessThanOrEqual(2);
  });

  it("takes superroutes, and routes in several, and survives a route containing itself", () => {
    const n = network([
      ...OPL,
      "r31 Ttype=superroute,route=bicycle,name=Trail Mr30@,r32@",
      "r32 Ttype=route,route=bicycle Mw12@,r31@",
      "r33 Ttype=route,route=bicycle Mr30@,r33@",
    ]);
    expect(n.routes.get(30)!.parents).toEqual([31, 33]);
    expect(n.routes.get(31)).toMatchObject({
      subroutes: [30, 32],
      parents: [32],
    });
    expect(n.routes.get(32)).toMatchObject({ subroutes: [31], parents: [31] });
    expect(n.routes.get(33)!.subroutes).toEqual([30]);
    // Every way once: w10, w11 and w12.
    expect(n.routes.get(31)!.lengthM).toBe(n.routes.get(32)!.lengthM);
    expect(n.routes.get(31)!.lengthM).toBeGreaterThan(2900);
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

  it("has the chain below it without ids or details, from the zoom its group is a pixel long", () => {
    const overview = lines.filter(
      (f) => f.tippecanoe.minzoom! < CYCLING_DETAIL_ZOOM,
    );
    // The two ways are one chain of ~2.2 km: over a pixel at z6 (~1.6 km at 49°).
    expect(overview).toHaveLength(1);
    expect(overview[0]!.tippecanoe).toMatchObject({
      minzoom: 6,
      maxzoom: CYCLING_DETAIL_ZOOM - 1,
    });
    expect(overview[0]!.id).toBeUndefined();
    expect(overview[0]!.properties).not.toHaveProperty("name");
    expect(overview[0]!.properties).not.toHaveProperty("routes");
  });

  it("shows a short chain as soon as the group it joins, and a lone one once it's a pixel long", () => {
    // A long path, a 100 m spur of the same kind off its middle (a junction), and a lone 100 m path.
    const n = network([
      "w1 Thighway=cycleway Nn1x-123.10y49.25,n2x-123.10y49.26",
      "w2 Thighway=cycleway Nn2x-123.10y49.26,n3x-123.10y49.27",
      "w3 Thighway=cycleway Nn2x-123.10y49.26,n4x-123.10y49.2609",
      "w4 Thighway=cycleway Nn5x-123.20y49.25,n6x-123.20y49.2509",
    ]);
    const minzooms = new Map(
      [...cyclingTileFeatures(n.ways, [])]
        .filter((f) => f.id === undefined)
        .map((f) => [
          JSON.stringify((f.geometry as LineString).coordinates.at(-1)),
          f.tippecanoe.minzoom,
        ]),
    );
    expect(minzooms.get("[-123.1,49.2609]")).toBe(6); // the spur
    // ~100 m is a pixel at z10 at 49° (~100 m).
    expect(minzooms.get("[-123.2,49.2509]")).toBe(10); // the lone path
  });

  it("gives bike parking ids that can't collide with paths'", () => {
    expect(
      features.filter((f) => f.geometry.type === "Point").map((f) => f.id),
    ).toEqual([osmFeatureId("node", 100), osmFeatureId("way", 20)]);
    expect(osmFeatureId("node", 100)).not.toBe(osmFeatureId("way", 100));
  });
});

describe("cyclingRouteTileFeatures", () => {
  it("gives each route with ways in the area its lines, joined", () => {
    const n = network([
      ...OPL,
      "r31 Ttype=route,route=bicycle,network=rcn Mr30@,w12@",
      "r32 Ttype=route,route=bicycle Mw404@",
    ]);
    const features = [...cyclingRouteTileFeatures(n)];
    expect(features.map((f) => f.id)).toEqual([
      osmFeatureId("relation", 30),
      osmFeatureId("relation", 31),
    ]);
    const r31 = features[1]!;
    expect(r31.properties).toEqual({ network: "rcn" });
    expect(r31.tippecanoe).toEqual({
      layer: CYCLING_ROUTES_LAYER,
      minzoom: CYCLING_MIN_ZOOM,
      maxzoom: CYCLING_ROUTES_MAX_ZOOM,
    });
    // w10, w11 and w12 end to end: one line.
    expect(r31.geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [-123.1, 49.25],
          [-123.1, 49.26],
          [-123.1, 49.27],
          [-123.11, 49.27],
        ],
      ],
    });
  });
});
