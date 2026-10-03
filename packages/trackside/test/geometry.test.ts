import { describe, expect, it } from "vitest";
import {
  cameraSetup,
  readTracks,
  speedKmh,
  travelBearing,
  zoomedHfov,
} from "../src/geometry.ts";

// Parallel east–west tracks at y metres north of 49.27°, a station at each end.
const M = 1 / 111_195;
const track = (id: string, y: number, kind = "main") => ({
  properties: { type: "segment", id, kind, lines: ["expo"] },
  geometry: {
    type: "LineString",
    coordinates: [
      [-123.11, 49.27 + y * M],
      [-123.09, 49.27 + y * M],
    ],
  },
});
const stops = [
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
];
const setupWith = (
  tracks: ReturnType<typeof track>[],
  at: [number, number],
  target: [number, number],
) => {
  const { segments, stations } = readTracks({
    features: [...tracks, ...stops],
  });
  return cameraSetup({
    id: "setup-0001",
    segments,
    stations,
    hfovDeg: 65,
    frameWidth: 1920,
    at: [-123.1 + at[0] * M, 49.27 + at[1] * M],
    target: [-123.1 + target[0] * M, 49.27 + target[1] * M],
  });
};
const twoTracks = [track("south", 0), track("north", 5)];

describe("cameraSetup", () => {
  it("from the south: the south track is nearest, and screen-right is east", () => {
    const s = setupWith(twoTracks, [0, -30], [0, 2.5]);
    if ("error" in s) throw new Error(s.error);
    expect(
      s.tracks.map((t) => [t.segment, Math.round(t.distanceM), t.kind]),
    ).toEqual([
      ["south", 30, "main"],
      ["north", 35, "main"],
    ]);
    expect(s).toMatchObject({
      lines: ["expo"],
      towardRight: "East",
      towardLeft: "West",
    });
    expect(Math.abs(s.rightwardBearing - 90)).toBeLessThan(1);
    expect(Math.abs(travelBearing(s, "left") - 270)).toBeLessThan(1);
  });

  it("from the north: the north track is nearest, and screen-right is west", () => {
    const s = setupWith(twoTracks, [0, 45], [0, 0]);
    expect(s).toMatchObject({ towardRight: "West" });
    if ("error" in s) throw new Error(s.error);
    expect(s.tracks.map((t) => t.segment)).toEqual(["north", "south"]);
  });

  it("one track, or three with a siding between the mains", () => {
    const one = setupWith([track("south", 0)], [0, -20], [0, 0]);
    if ("error" in one) throw new Error(one.error);
    expect(one.tracks).toHaveLength(1);
    const three = setupWith(
      [track("south", 0), track("siding", 4.5, "siding"), track("north", 9)],
      [0, -15],
      [0, 4.5],
    );
    if ("error" in three) throw new Error(three.error);
    expect(three.tracks.map((t) => [t.segment, t.kind])).toEqual([
      ["south", "main"],
      ["siding", "siding"],
      ["north", "main"],
    ]);
  });

  it("explains a target away from the guideway, a camera on it, or too many tracks", () => {
    expect(setupWith(twoTracks, [0, -1000], [0, -500])).toHaveProperty("error");
    expect(setupWith(twoTracks, [0, 0], [0, 0])).toHaveProperty("error");
    const four = [0, 4, 8, 12].map((y) => track(`t${y}`, y));
    expect(setupWith(four, [0, -20], [0, 6])).toEqual({
      error:
        "4 tracks in view: up to 3 are supported. Film somewhere with fewer tracks side by side.",
    });
  });
});

describe("speedKmh", () => {
  it("converts image speed with the camera's geometry", () => {
    // 30 m away, 65° across 1920 px: 38.2 m across, so 1000 px/s ≈ 19.9 m/s ≈ 72 km/h.
    expect(speedKmh(1000, 30, 65, 1920)).toBe(72);
    expect(zoomedHfov(65, 2)).toBeCloseTo(35.3, 1);
  });
});
