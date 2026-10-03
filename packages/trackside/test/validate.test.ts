import { describe, expect, it } from "vitest";
import { jpegBytes, passProblems } from "../src/validate.ts";
import type { PassReport } from "../src/types.ts";

const jpeg = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3))}`;

const report = (patch: Partial<PassReport> = {}): PassReport => ({
  id: "3f2c9a1e-0000-4000-8000-000000000001",
  setup: {
    id: "8a1b2c3d-0000-4000-8000-000000000002",
    at: [-123.1008, 49.27295],
    lines: ["expo"],
    tracks: [
      { segment: "w1.0", distanceM: 37, kind: "main", lines: ["expo"] },
      { segment: "w2.0", distanceM: 44, kind: "main", lines: ["expo"] },
    ],
    rightwardBearing: 110,
    towardRight: "Commercial–Broadway",
    towardLeft: "Stadium–Chinatown",
    hfovDeg: 65,
    frameWidth: 1920,
  },
  start: "2026-10-01T22:44:40.000Z",
  end: "2026-10-01T22:44:47.000Z",
  track: 0,
  trackSegment: "w1.0",
  extent: [0.2, 0.7],
  screen: "right",
  bearing: 110,
  toward: "Commercial–Broadway",
  speedKmh: 62,
  pxPerS: 1700,
  occluded: false,
  cars: [{ number: "317", confidence: 0.99, reads: 2, crop: jpeg }],
  uncertain: [{ number: "35", confidence: 0.7, reads: 1, crop: jpeg }],
  source: "camera",
  ...patch,
});

describe("passProblems", () => {
  it("accepts a camera report", () => {
    expect(passProblems(report())).toEqual([]);
  });

  it("refuses a track that isn't in view, and bad rows", () => {
    expect(passProblems(report({ track: 2 }))).toEqual([
      "track must be an index into setup.tracks",
    ]);
    expect(passProblems(report({ extent: [0.7, 0.2] }))).toEqual([
      "extent must be [top, bottom] fractions, top first",
    ]);
  });

  it("refuses clips, bad times and bad crops", () => {
    expect(passProblems(report({ source: "file" }))).toEqual([
      "only live camera passes are stored",
    ]);
    expect(passProblems(report({ start: "2026-10-01 22:44" }))).toEqual([
      "start and end must be ISO 8601 times with offset, start first",
    ]);
    expect(
      passProblems(report({ end: "2026-10-01T22:44:00.000Z" })),
    ).toHaveLength(1);
    expect(
      passProblems(
        report({
          cars: [
            {
              number: "317",
              confidence: 0.9,
              reads: 1,
              crop: "data:image/png;base64,AAAA",
            },
          ],
        }),
      ),
    ).toEqual(["317: crop must be a JPEG data: URL under 40000 bytes"]);
  });

  it("decodes JPEG data: URLs", () => {
    expect(jpegBytes(jpeg)?.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(
      jpegBytes(`data:image/jpeg;base64,${btoa("not a jpeg")}`),
    ).toBeUndefined();
  });
});
