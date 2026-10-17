import { describe, expect, it } from "vitest";
import {
  matchShape,
  RoadGraph,
  type OsmElement,
} from "../src/plan/road-match.ts";
import { buildCorridors, mergeCarriageways } from "../src/plan/corridors.ts";
import { BusFrequency, frequencyTier } from "../src/plan/bus-frequency.ts";
import type { LonLat } from "../src/geo.ts";
import type { ServicePlan } from "../src/plan/types.ts";
import { serviceDate } from "../src/time.ts";

// A small street grid near 49.25°N: A (one-way eastbound) along nodes 1–5, 182 m apart; B (two-way)
// 110 m north along nodes 6–10; and C (two-way) joining A's node 3 to B's node 8.
const LAT_A = 49.25;
const LAT_B = 49.251;
const lon = (i: number) => -123.1 + i * 0.0025;
const nodes: OsmElement[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({
    type: "node",
    id: i + 1,
    lon: lon(i),
    lat: LAT_A,
  })),
  ...[0, 1, 2, 3, 4].map((i) => ({
    type: "node",
    id: i + 6,
    lon: lon(i),
    lat: LAT_B,
  })),
];
const osm: OsmElement[] = [
  ...nodes,
  {
    type: "way",
    id: 100,
    nodes: [1, 2, 3, 4, 5],
    tags: { highway: "secondary", oneway: "yes" },
  },
  {
    type: "way",
    id: 101,
    nodes: [6, 7, 8, 9, 10],
    tags: { highway: "secondary" },
  },
  { type: "way", id: 102, nodes: [3, 8], tags: { highway: "residential" } },
];
const g = RoadGraph.fromOsm(osm);

describe("matchShape", () => {
  it("snaps a coarse shape onto the road it follows", () => {
    // 8 m north of A, with a stray vertex 15 m off.
    const shape: LonLat[] = [
      [lon(0), LAT_A + 0.00007],
      [lon(2), LAT_A + 0.00013],
      [lon(4), LAT_A + 0.00007],
    ];
    const m = matchShape(g, shape);
    expect(m.matched).toBe(1);
    for (const [, la] of m.coords)
      expect(Math.abs(la - LAT_A)).toBeLessThan(1e-6);
    expect(m.coords[0]![0]).toBeCloseTo(lon(0), 6);
    expect(m.coords.at(-1)![0]).toBeCloseTo(lon(4), 6);
  });

  it("follows the roads around a corner the shape cuts", () => {
    // Along A, then a chord across the corner at node 3 to B, as GTFS shapes often do.
    const shape: LonLat[] = [
      [lon(0), LAT_A],
      [lon(1.7), LAT_A],
      [lon(2.5), LAT_B],
    ];
    const m = matchShape(g, shape);
    expect(m.matched).toBe(1);
    // Through the corner (node 3) and up C to B (node 8).
    const has = (x: number, y: number) =>
      m.coords.some(
        ([a, b]) => Math.abs(a - x) < 1e-6 && Math.abs(b - y) < 1e-6,
      );
    expect(has(lon(2), LAT_A)).toBe(true);
    expect(has(lon(2), LAT_B)).toBe(true);
  });

  it("keeps the GTFS geometry where there's no road", () => {
    const far: LonLat[] = [
      [lon(0), 49.26],
      [lon(4), 49.26],
    ];
    const m = matchShape(g, far);
    expect(m.matched).toBe(0);
    expect(m.pieces.every((p) => "raw" in p)).toBe(true);
  });
});

describe("buildCorridors", () => {
  it("merges patterns on the same road and splits where they part", () => {
    const along: LonLat[] = [
      [lon(0), LAT_A],
      [lon(4), LAT_A],
    ];
    const turning: LonLat[] = [
      [lon(0), LAT_A],
      [lon(2), LAT_A],
      [lon(2), LAT_B],
      [lon(3), LAT_B],
    ];
    const corridors = buildCorridors(g, [
      { pattern: 0, pieces: matchShape(g, along).pieces },
      { pattern: 1, pieces: matchShape(g, turning).pieces },
    ]);
    const refsOf = (c: (typeof corridors)[number]) =>
      c.refs
        .map((r) => r[0])
        .sort((a, b) => a - b)
        .join(",");
    const shared = corridors.filter((c) => refsOf(c) === "0,1");
    expect(shared).toHaveLength(1);
    // Nodes 1–3: about 365 m of road.
    expect(shared[0]!.coords[0]![0]).toBeCloseTo(lon(0), 6);
    expect(shared[0]!.coords.at(-1)![0]).toBeCloseTo(lon(2), 6);
    expect(corridors.filter((c) => refsOf(c) === "0")).toHaveLength(1);
    expect(corridors.filter((c) => refsOf(c) === "1").length).toBeGreaterThan(
      0,
    );
    // Pattern 1 has C and B to itself, one corridor it enters at the corner, about 365 m along.
    const own = corridors.find((c) => refsOf(c) === "1")!;
    expect(own.coords[0]![0]).toBeCloseTo(lon(2), 6);
    expect(own.refs[0]![1]).toBe(1);
    expect(own.refs[0]![2]).toBeGreaterThan(350);
    expect(own.refs[0]![2]).toBeLessThan(380);
  });
});

describe("mergeCarriageways", () => {
  // A divided road 20 m wide (eastbound north half, westbound south half) for 500 m, then a two-way
  // street beyond. Pattern 0 runs east along both, pattern 1 west.
  const y = (m: number) => LAT_A + m / 111_200;
  const x = (m: number) =>
    -123.1 + m / (111_200 * Math.cos((LAT_A * Math.PI) / 180));
  const corridors = mergeCarriageways([
    {
      coords: [
        [x(0), y(10)],
        [x(500), y(10)],
      ],
      refs: [[0, 1, 0]],
    },
    {
      coords: [
        [x(500), y(-10)],
        [x(0), y(-10)],
      ],
      refs: [[1, 1, 300]],
    },
    {
      coords: [
        [x(500), y(0)],
        [x(800), y(0)],
      ],
      refs: [
        [0, 1, 500],
        [1, -1, 0],
      ],
    },
  ]);

  it("puts both directions on one line along the centreline", () => {
    const both = corridors.filter((c) => c.refs.length === 2);
    const length = (c: (typeof corridors)[number]) =>
      Math.abs(c.coords.at(-1)![0] - c.coords[0]![0]) / (x(1) - x(0));
    // The divided road and the street beyond, as (nearly) one corridor carrying both.
    expect(both.reduce((sum, c) => sum + length(c), 0)).toBeGreaterThan(700);
    for (const c of both)
      for (const [, la] of c.coords.slice(1, -1))
        expect(Math.abs(la - LAT_A) * 111_200).toBeLessThan(2);
    // One corridor, the patterns running opposite ways along it, each entering at its start.
    expect(both).toHaveLength(1);
    const dirs = Object.fromEntries(
      both[0]!.refs.map(([p, d, a]) => [p, [d, a]]),
    );
    expect(dirs[0]![0]).toBe(-dirs[1]![0]!);
    expect(dirs[0]![1]).toBeLessThan(10);
    expect(dirs[1]![1]).toBeLessThan(10);
  });

  it("leaves other corridors as they are", () => {
    const lone = mergeCarriageways([
      {
        coords: [
          [x(0), y(10)],
          [x(500), y(10)],
        ],
        refs: [[0, 1, 0]],
      },
    ]);
    expect(lone).toHaveLength(1);
    expect(lone[0]!.coords[0]![1]).toBeCloseTo(y(10), 6);
  });
});

describe("BusFrequency", () => {
  // One pattern, two stops 10 minutes apart; weekday trips every 10 min 06:00–22:00, then hourly to 01:00.
  const starts = [
    ...Array.from({ length: 96 }, (_, i) => 6 * 3600 + i * 600),
    ...[22, 23, 24, 25].map((h) => h * 3600 + 1800),
  ];
  const plan = {
    patterns: [
      {
        id: 0,
        route: "9",
        direction: 0,
        shape: "s",
        stops: [0, 1],
        dist: [0, 2000],
      },
    ],
    trips: starts.map((start, i) => ({
      id: `t${i}`,
      pattern: 0,
      service: "wk",
      headsign: "",
      start,
      arr: [0, 600],
    })),
    calendar: {
      calendar: [
        {
          serviceId: "wk",
          days: [true, true, true, true, true, false, false],
          start: serviceDate("20261001"),
          end: serviceDate("20261231"),
        },
      ],
      exceptions: [],
    },
  } as unknown as ServicePlan;
  const freq = new BusFrequency(plan);
  const wed = serviceDate("20261021");
  const at = (along: number) => [[[0, freq.offsetAt(0, along), 1] as const]];

  it("counts buses passing in the hour around a time", () => {
    expect(freq.count(at(0), wed, "now", 12 * 3600, () => true)[0]).toBe(6);
    // Halfway along, buses pass 5 minutes after they start.
    expect(freq.offsetAt(0, 1000)).toBe(300);
    expect(freq.count(at(1000), wed, "now", 12 * 3600, () => true)[0]).toBe(6);
    expect(frequencyTier(6)).toBe(1);
  });

  it("averages over the day and the night after it", () => {
    // 06:00–24:00: 96 + 2 trips over 18 h.
    expect(freq.count(at(0), wed, "day", 0, () => true)[0]).toBeCloseTo(
      98 / 18,
      5,
    );
    // 00:00–06:00 after Wednesday: the 00:30 and 01:30 trips (Wednesday's 24:30 and 25:30).
    expect(freq.count(at(0), wed, "night", 0, () => true)[0]).toBeCloseTo(
      2 / 6,
      5,
    );
  });

  it("has nothing on days without service, and leaves out excluded patterns", () => {
    expect(
      freq.count(
        at(0),
        serviceDate("20261024"),
        "now",
        12 * 3600,
        () => true,
      )[0],
    ).toBe(0);
    expect(freq.count(at(0), wed, "now", 12 * 3600, () => false)[0]).toBe(0);
    expect(frequencyTier(0)).toBe(-1);
  });
});
