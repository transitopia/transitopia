import { describe, expect, it } from "vitest";
import {
  matchOsmStops,
  osmBay,
  osmBusStops,
  type OsmBusStop,
} from "../src/features/osm-stops.ts";

const settings = { matchM: 150 };
/** About 11 m of latitude. */
const M10 = 0.0001;

const node = (
  id: number,
  lat: number,
  tags: Record<string, string>,
): OsmBusStop => ({ id, lon: -119.272, lat, tags });

describe("osmBay", () => {
  it("reads local_ref, then the name", () => {
    expect(osmBay({ local_ref: "C", name: "Downtown Exchange" })).toBe("C");
    expect(osmBay({ name: "Downtown Exchange A" })).toBe("A");
    expect(osmBay({ name: "Downtown Exchange Bay F" })).toBe("F");
    expect(osmBay({ name: "Queensway Exch 12" })).toBe("12");
    expect(osmBay({ name: "Lougheed Station @ Bay 7" })).toBe("7");
  });

  it("ignores what isn't a bay", () => {
    expect(osmBay({ local_ref: "BC Transit" })).toBeUndefined();
    expect(osmBay({ name: "Main St (NB) at East 33rd Ave" })).toBeUndefined();
    expect(osmBay({ name: "Downtown Exchange" })).toBeUndefined();
    expect(osmBay({})).toBeUndefined();
  });
});

describe("osmBusStops", () => {
  it("keeps bus stop nodes once, with the tags it reads", () => {
    const stops = osmBusStops([
      {
        type: "node",
        id: 1,
        lon: -119,
        lat: 50,
        tags: { highway: "bus_stop", ref: "144000", bench: "yes" },
      },
      { type: "node", id: 1, lon: -119, lat: 50 },
      { type: "node", id: 2, lon: -119, lat: 50 },
      { type: "way", id: 3, tags: { highway: "bus_stop" } },
    ]);
    expect(stops).toEqual([
      { id: 1, lon: -119, lat: 50, tags: { ref: "144000" } },
    ]);
  });
});

describe("matchOsmStops", () => {
  it("matches by code within matchM, the nearest node of it", () => {
    const osm = [
      node(1, 50.2646, { ref: "144000", name: "Downtown Exchange A" }),
      node(2, 50.2646 + 5 * M10, { ref: "144000" }),
      node(3, 50.2646, { ref: "144037;55555" }),
      node(4, 50.2646 + 20 * M10, { ref: "144038" }),
    ];
    const at = (code: string | undefined) => ({
      code,
      lon: -119.272,
      lat: 50.2646 + M10,
    });
    expect(
      matchOsmStops(
        [at("144000"), at("144037"), at("144038"), at(undefined), at("9")],
        osm,
        settings,
      ),
    ).toEqual([
      { node: 1, bay: "A", m: 11 },
      { node: 3, bay: undefined, m: 11 },
      undefined, // 210 m away
      undefined,
      undefined,
    ]);
  });

  it("gives a node two stops match to the nearer", () => {
    const osm = [node(1, 50, { ref: "100" })];
    expect(
      matchOsmStops(
        [
          { code: "100", lon: -119.272, lat: 50 + 3 * M10 },
          { code: "100", lon: -119.272, lat: 50 + M10 },
        ],
        osm,
        settings,
      ),
    ).toEqual([undefined, { node: 1, bay: undefined, m: 11 }]);
  });
});
