import { describe, expect, it } from "vitest";
import { osmFeatureId } from "@transitopia/cycling-core/tiles.ts";
import {
  asElement,
  elementMatches,
  keyOfElement,
  osmRef,
} from "../src/CyclingMap/cycling-select.ts";

// Tile features as MapLibre gives them: a path (a chain whose first way by id is 7) and bike parking.
const path = {
  id: osmFeatureId("way", 7),
  properties: { class: "track", comfort: 4 },
};
const rack = {
  id: osmFeatureId("node", 100),
  properties: { amenity: "bicycle_parking", osmNodeId: 100 },
};
const area = {
  id: osmFeatureId("way", 20),
  properties: { amenity: "bicycle_parking", osmWayId: 20 },
};

/** Select a feature, write its key, read the key back and find the feature again. */
const roundTrip = (f: typeof path | typeof rack | typeof area) => {
  const key = keyOfElement(asElement(f));
  return { key, found: elementMatches(osmRef(key)!, f) };
};

describe("?select= on /cycling", () => {
  it("round-trips a path by its first way by id (the resolver finds the others)", () => {
    expect(roundTrip(path)).toEqual({ key: "osm-way:7", found: true });
    expect(elementMatches(osmRef("osm-way:30")!, path)).toBe(false);
  });

  it("round-trips bike parking, a node or an area", () => {
    expect(roundTrip(rack)).toEqual({ key: "osm-node:100", found: true });
    expect(roundTrip(area)).toEqual({ key: "osm-way:20", found: true });
    expect(elementMatches(osmRef("osm-way:100")!, rack)).toBe(false);
    expect(elementMatches(osmRef("osm-node:20")!, area)).toBe(false);
  });

  it("takes only OSM refs it can select", () => {
    expect(osmRef("osm-relation:123")).toMatchObject({ value: "123" });
    expect(osmRef("osm-way:abc")).toBeUndefined();
    expect(osmRef("sn-k3v9qd7m")).toBeUndefined();
    expect(osmRef("stop:translink:50123")).toBeUndefined();
  });
});
