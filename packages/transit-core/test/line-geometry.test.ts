import { describe, expect, it } from "vitest";
import { lineGeometry, RIBBON_M } from "../src/infra/line-geometry.ts";
import type { InfraCollection } from "../src/infra/types.ts";

// Two parallel tracks 4 m apart running east for 400 m, shared by lines a and b for the first 200 m,
// then line a only; plus a crossover between them.
const LAT = 49.25;
const x = (m: number) => -123 + m / (111_320 * Math.cos((LAT * Math.PI) / 180));
const y = (m: number) => LAT + m / 111_320;
const seg = (
  id: string,
  lines: string[],
  kind: string,
  coords: [number, number][],
) => ({
  type: "Feature",
  properties: {
    type: "segment",
    id,
    kind,
    lines,
    from: `${id}a`,
    to: `${id}b`,
    length: 0,
    osmWay: 1,
  },
  geometry: {
    type: "LineString",
    coordinates: coords.map(([m, n]) => [x(m), y(n)]),
  },
});
const tracks = {
  type: "FeatureCollection",
  metadata: { source: "test", generatedAt: "" },
  features: [
    seg("n1", ["a", "b"], "main", [
      [0, 2],
      [200, 2],
    ]),
    seg("s1", ["a", "b"], "main", [
      [0, -2],
      [200, -2],
    ]),
    seg("n2", ["a"], "main", [
      [200, 2],
      [400, 2],
    ]),
    seg("s2", ["a"], "main", [
      [200, -2],
      [400, -2],
    ]),
    seg("x", ["a"], "crossover", [
      [250, 2],
      [300, -2],
    ]),
  ],
} as unknown as InfraCollection;
const g = lineGeometry(tracks);
const toM = ([lo, la]: number[]) => [
  (lo! - x(0)) * 111_320 * Math.cos((LAT * Math.PI) / 180),
  (la! - LAT) * 111_320,
];

describe("lineGeometry", () => {
  it("puts paired tracks on one centreline", () => {
    for (const f of g.features.filter((f) => f.properties.type === "centre"))
      for (const p of f.geometry.coordinates as number[][])
        expect(Math.abs(toM(p)[1]!)).toBeLessThan(0.3);
  });

  it("gives each line one ribbon, the shared section split between them", () => {
    const ribbons = g.features.filter((f) => f.properties.type === "ribbon");
    expect(ribbons.map((f) => f.properties.line).sort()).toEqual(["a", "b"]);
    const ys = (line: string) =>
      (
        ribbons.find((f) => f.properties.line === line)!.geometry
          .coordinates as number[][][][]
      )
        .flat(2)
        .map((p) => toM(p));
    // Line b: only the shared 200 m, on the right (south) half of the west-to-east centreline.
    const b = ys("b");
    expect(Math.max(...b.map(([m]) => m!))).toBeLessThan(200 + RIBBON_M);
    expect(Math.max(...b.map(([, n]) => n!))).toBeLessThan(0.5);
    // Line a: the north half of the shared part and all of its own, full width; the crossover inside.
    const a = ys("a");
    expect(Math.max(...a.map(([m]) => m!))).toBeGreaterThan(400);
    expect(
      Math.min(...a.filter(([m]) => m! > 220).map(([, n]) => n!)),
    ).toBeLessThan(-2 - RIBBON_M / 2 + 0.5);
  });
});
