import { describe, expect, it } from "vitest";
import {
  bandProfile,
  decodeBandProfile,
  encodeBandProfile,
} from "../src/rt/profile-bands.ts";
import type { RtProfile } from "../src/rt/profile.ts";

const profile: RtProfile = {
  feedVersion: "V1",
  builtAt: "2026-10-31T00:00:00.000Z",
  binM: 25,
  bandStartHours: [0, 6, 9],
  hours: ["2026-10-30T08"],
  shapes: {
    A: {
      bands: [
        null,
        { pace: [0.5, null, null, 0.05], dwell: { s1: 40 } },
        { pace: [null, null, null, null], dwell: {} },
      ],
      all: { pace: [0.1, 0.2, null, 0.08], dwell: { s1: 20, s2: 400 } },
    },
  },
};

describe("profile bands", () => {
  it("fill a band's gaps from the all-day profile", () => {
    const a = bandProfile(profile, 1).shapes.get("A")!;
    expect([...a.pace]).toEqual([
      Math.fround(0.5),
      Math.fround(0.2),
      NaN,
      Math.fround(0.05),
    ]);
    expect(a.stops).toEqual(["s1", "s2"]);
    expect([...a.dwell]).toEqual([40, 400]);
    // A band with no data of its own is the all-day profile.
    expect([...bandProfile(profile, 0).shapes.get("A")!.pace]).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      NaN,
      Math.fround(0.08),
    ]);
  });

  it("round-trip through the file within the encoding's steps", () => {
    const band = bandProfile(profile, 1);
    const back = decodeBandProfile(encodeBandProfile(band));
    expect(back).toMatchObject({
      feedVersion: "V1",
      binM: 25,
      bandStartHours: [0, 6, 9],
      band: 1,
    });
    const a = band.shapes.get("A")!;
    const b = back.shapes.get("A")!;
    for (let i = 0; i < a.pace.length; i++)
      if (Number.isNaN(a.pace[i]!)) expect(b.pace[i]).toBeNaN();
      else expect(Math.abs(b.pace[i]! / a.pace[i]! - 1)).toBeLessThan(0.015);
    expect(b.stops).toEqual(["s1", "s2"]);
    // Dwells are whole seconds up to 255.
    expect([...b.dwell]).toEqual([40, 255]);
  });

  it("clamp paces outside the encoding's range", () => {
    const band = bandProfile(
      {
        ...profile,
        shapes: {
          A: { bands: [], all: { pace: [0.001, 1000], dwell: {} } },
        },
      },
      0,
    );
    const b = decodeBandProfile(encodeBandProfile(band)).shapes.get("A")!;
    expect(b.pace[0]).toBeCloseTo(0.02, 5);
    expect(b.pace[1]).toBeGreaterThan(30);
  });
});
