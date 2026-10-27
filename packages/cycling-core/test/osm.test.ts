import { describe, expect, it } from "vitest";
import { parseOpl } from "../src/osm.ts";

describe("parseOpl", () => {
  it("reads a node with escaped tags", () => {
    expect(
      parseOpl(
        "n7 Tamenity=bicycle_parking,name=Caf%e9%%20%Rack%2c%%20%Main x-123.1 y49.25",
      ),
    ).toEqual({
      type: "node",
      id: 7,
      tags: { amenity: "bicycle_parking", name: "Café Rack, Main" },
      lon: -123.1,
      lat: 49.25,
    });
  });

  it("reads a way with node locations, missing ones included", () => {
    expect(
      parseOpl("w5 Thighway=cycleway Nn1x-123y49,n2xy,n3x-123.2y49.1"),
    ).toEqual({
      type: "way",
      id: 5,
      tags: { highway: "cycleway" },
      nodes: [1, 2, 3],
      coords: [[-123, 49], undefined, [-123.2, 49.1]],
    });
  });

  it("reads a relation's members and roles", () => {
    expect(
      parseOpl("r9 Ttype=route,route=bicycle Mw1@,w2@forward,r3@,n4@stop"),
    ).toEqual({
      type: "relation",
      id: 9,
      tags: { type: "route", route: "bicycle" },
      members: [
        { type: "way", ref: 1, role: "" },
        { type: "way", ref: 2, role: "forward" },
        { type: "relation", ref: 3, role: "" },
        { type: "node", ref: 4, role: "stop" },
      ],
    });
  });

  it("reads an element without tags, and skips blank lines", () => {
    expect(parseOpl("w5 T Nn1x0y0,n2x1y1")).toMatchObject({ tags: {} });
    expect(parseOpl("")).toBeUndefined();
  });
});
