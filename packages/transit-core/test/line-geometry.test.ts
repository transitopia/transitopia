import { describe, expect, it } from "vitest";
import {
  lineGeometry,
  RIBBON_M,
  type ServiceExtents,
} from "../src/infra/line-geometry.ts";
import type { InfraCollection } from "../src/infra/types.ts";

// Two parallel tracks 4 m apart running east for 400 m, shared by lines a and b for the first 200 m,
// then line a only; a crossover between them at 250–300 m. Trains run all of the north track and
// the south track to 350 m; past that, a tail track (400–500 m, north) and a crossover between the
// track ends (400 m) aren't service track.
const LAT = 49.25;
const x = (m: number) => -123 + m / (111_320 * Math.cos((LAT * Math.PI) / 180));
const y = (m: number) => LAT + m / 111_320;
const seg = (
  id: string,
  lines: string[],
  kind: string,
  from: string,
  to: string,
  coords: [number, number][],
) => ({
  type: "Feature",
  properties: {
    type: "segment",
    id,
    kind,
    lines,
    from,
    to,
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
    seg("n1", ["a", "b"], "main", "N0", "N200", [
      [0, 2],
      [200, 2],
    ]),
    seg("s1", ["a", "b"], "main", "S0", "S200", [
      [0, -2],
      [200, -2],
    ]),
    seg("n2", ["a"], "main", "N200", "N250", [
      [200, 2],
      [250, 2],
    ]),
    seg("n3", ["a"], "main", "N250", "N400", [
      [250, 2],
      [400, 2],
    ]),
    seg("s2", ["a"], "main", "S200", "S300", [
      [200, -2],
      [300, -2],
    ]),
    seg("s3", ["a"], "main", "S300", "S400", [
      [300, -2],
      [400, -2],
    ]),
    seg("x", ["a"], "crossover", "N250", "S300", [
      [250, 2],
      [300, -2],
    ]),
    seg("t", ["a"], "tail", "N400", "T", [
      [400, 2],
      [500, 2],
    ]),
    seg("y", ["a"], "crossover", "N400", "S400", [
      [400, 2],
      [440, -2],
    ]),
  ],
} as unknown as InfraCollection;
// Extents past a segment's end reach its end.
const service: ServiceExtents = new Map([
  ["n1", [0, 1000]],
  ["s1", [0, 1000]],
  ["n2", [0, 1000]],
  ["n3", [0, 1000]],
  ["s2", [0, 1000]],
  ["s3", [0, 50]],
]);
const g = lineGeometry(tracks, service);
const toM = ([lo, la]: number[]) => [
  (lo! - x(0)) * 111_320 * Math.cos((LAT * Math.PI) / 180),
  (la! - LAT) * 111_320,
];

describe("lineGeometry", () => {
  it("puts paired tracks on one centreline", () => {
    // (Past 350 m the north track runs alone.)
    for (const f of g.features.filter((f) => f.properties.type === "centre"))
      for (const p of f.geometry.coordinates as number[][])
        if (toM(p)[0]! < 340) expect(Math.abs(toM(p)[1]!)).toBeLessThan(0.3);
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

  it("draws only service track in the line's colour", () => {
    const ribbon = g.features.find(
      (f) => f.properties.type === "ribbon" && f.properties.line === "a",
    )!;
    const xs = (ribbon.geometry.coordinates as number[][][][])
      .flat(2)
      .map((p) => toM(p)[0]!);
    expect(Math.max(...xs)).toBeLessThan(400 + RIBBON_M);
    const pieces = g.features.flatMap((f) =>
      f.properties.type === "track" ?
        [
          {
            ...f.properties,
            xs: (f.geometry.coordinates as number[][]).map((p) => toM(p)[0]!),
          },
        ]
      : [],
    );
    const piece = (kind: string, service: boolean, from: number) =>
      pieces.find(
        (p) =>
          p.kind === kind
          && p.service === service
          && Math.abs(Math.min(...p.xs) - from) < 1,
      );
    // The crossover between service tracks is service track; the one past the platforms isn't.
    expect(piece("crossover", true, 250)).toBeDefined();
    expect(piece("crossover", false, 400)).toBeDefined();
    expect(piece("tail", false, 400)).toBeDefined();
    // The south track to 350 m, the rest grey.
    expect(piece("main", true, 300)).toBeDefined();
    expect(piece("main", false, 350)).toBeDefined();
  });
});
