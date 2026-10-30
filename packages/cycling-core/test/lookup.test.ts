import { describe, expect, it } from "vitest";
import { CyclingNetworkBuilder } from "../src/network.ts";
import { parseOpl } from "../src/osm.ts";
import { cyclingLookup, findCyclingFeature } from "../src/lookup.ts";
import { detailChains } from "../src/tiles.ts";

const b = new CyclingNetworkBuilder({ calmMaxSpeedKmh: 30 });
for (const l of [
  "n100 Tamenity=bicycle_parking,name=Rack x-123.1 y49.25",
  "w10 Thighway=cycleway,name=Seaside Nn1x-123.10y49.25,n2x-123.10y49.26",
  "w11 Thighway=cycleway,name=Seaside Nn2x-123.10y49.26,n3x-123.11y49.27",
  "w20 Tamenity=bicycle_parking Nn5x0y0,n6x1y0,n7x1y1,n8x0y1,n5x0y0",
  "w30 Thighway=residential Nn9x0y0,n10x1y1",
])
  b.add(parseOpl(l)!);
const n = b.build();
const lookup = cyclingLookup(detailChains(n.ways), n.parking);
const find = (key: string) => findCyclingFeature(key, lookup);

describe("findCyclingFeature", () => {
  it("finds a path's chain by any of its ways, keyed by its first", () => {
    const chain = {
      key: "osm-way:10",
      kind: "cycling-way",
      name: "Seaside",
      centroid: [-123.105, 49.26],
      bbox: [-123.11, 49.25, -123.1, 49.27],
    };
    expect(find("osm-way:10")).toEqual(chain);
    expect(find("osm-way:11")).toEqual(chain);
  });

  it("finds bike parking by node, or by the way around it", () => {
    expect(find("osm-node:100")).toEqual({
      key: "osm-node:100",
      kind: "bike-parking",
      name: "Rack",
      centroid: [-123.1, 49.25],
      bbox: [-123.1, 49.25, -123.1, 49.25],
    });
    expect(find("osm-way:20")).toMatchObject({
      key: "osm-way:20",
      kind: "bike-parking",
      name: null,
      centroid: [0.5, 0.5],
    });
  });

  it("knows nothing else", () => {
    expect(find("osm-way:30")).toBeUndefined(); // not a cycling way
    expect(find("osm-node:1")).toBeUndefined(); // a path's node
    expect(find("osm-way:constructor")).toBeUndefined();
    expect(find("osm-relation:40")).toBeUndefined(); // bike routes are in the database
    expect(find("sn-k3v9qd7m")).toBeUndefined();
    expect(find("gtfs-stop:translink:10")).toBeUndefined();
  });
});
