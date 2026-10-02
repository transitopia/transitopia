import { describe, expect, it } from "vitest";
import {
  cameraSetup,
  readTracks,
  speedKmh,
  travelBearing,
  zoomedHfov,
} from "../src/geometry.ts";

// Two parallel east–west tracks 5 m apart (north and south), a station at each end.
const dLat = 5 / 111_195;
const fc = {
  features: [
    {
      properties: { type: "segment", id: "south", lines: ["expo"] },
      geometry: {
        type: "LineString",
        coordinates: [
          [-123.11, 49.27],
          [-123.09, 49.27],
        ],
      },
    },
    {
      properties: { type: "segment", id: "north", lines: ["expo"] },
      geometry: {
        type: "LineString",
        coordinates: [
          [-123.09, 49.27 + dLat],
          [-123.11, 49.27 + dLat],
        ],
      },
    },
    {
      properties: { type: "stop", name: "West", segment: "south" },
      geometry: { type: "Point", coordinates: [-123.105, 49.27] },
    },
    {
      properties: { type: "stop", name: "East", segment: "south" },
      geometry: { type: "Point", coordinates: [-123.095, 49.27] },
    },
    {
      properties: { type: "stop", name: "Elsewhere", segment: "other" },
      geometry: { type: "Point", coordinates: [-123.098, 49.27] },
    },
  ],
};
const { segments, stations } = readTracks(fc);
const base = {
  id: "setup-0001",
  segments,
  stations,
  hfovDeg: 65,
  frameWidth: 1920,
};

describe("cameraSetup", () => {
  it("from the south: the south track is near, and screen-right is east", () => {
    const s = cameraSetup({
      ...base,
      at: [-123.1, 49.27 - 30 / 111_195],
      target: [-123.1, 49.27 + dLat / 2],
    });
    expect(s).toMatchObject({
      nearSegment: "south",
      farSegment: "north",
      lines: ["expo"],
      towardRight: "East",
      towardLeft: "West",
    });
    if ("error" in s) throw new Error(s.error);
    expect(s.nearDistanceM).toBeCloseTo(30, 0);
    expect(s.farDistanceM).toBeCloseTo(35, 0);
    expect(Math.abs(s.rightwardBearing - 90)).toBeLessThan(1);
    expect(Math.abs(travelBearing(s, "left") - 270)).toBeLessThan(1);
  });

  it("from the north: the north track is near, and screen-right is west", () => {
    const s = cameraSetup({
      ...base,
      at: [-123.1, 49.27 + 40 / 111_195],
      target: [-123.1, 49.27],
    });
    expect(s).toMatchObject({
      nearSegment: "north",
      farSegment: "south",
      towardRight: "West",
    });
  });

  it("explains a target away from the guideway, or a camera on it", () => {
    expect(
      cameraSetup({ ...base, at: [-123.1, 49.26], target: [-123.1, 49.265] }),
    ).toHaveProperty("error");
    expect(
      cameraSetup({ ...base, at: [-123.1, 49.27], target: [-123.1, 49.27] }),
    ).toHaveProperty("error");
  });
});

describe("speedKmh", () => {
  it("converts image speed with the camera's geometry", () => {
    // 30 m away, 65° across 1920 px: 38.2 m across, so 1000 px/s ≈ 19.9 m/s ≈ 72 km/h.
    expect(speedKmh(1000, 30, 65, 1920)).toBe(72);
    expect(zoomedHfov(65, 2)).toBeCloseTo(35.3, 1);
  });
});
