import { describe, expect, it } from "vitest";
import {
  matchShape,
  RoadGraph,
  type OsmElement,
} from "../src/plan/road-match.ts";
import { buildCorridors, mergeCarriageways } from "../src/plan/corridors.ts";
import { BusFrequency } from "../src/plan/bus-frequency.ts";
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

  it("follows a road beside a busier one that crowds it out of the nearest candidates", () => {
    // A street from the south becomes a one-way ramp east along y = 0. A motorway and its link run
    // alongside, 10 and 14 m north, in 4 m segments and not connected to the ramp. The shape runs
    // up the street, then along the motorway (as Phibbs Exchange's buses onto the Ironworkers
    // bridge): only the ramp continues from the street.
    const mx = (m: number) =>
      -123.1 + m / (111_200 * Math.cos((LAT_A * Math.PI) / 180));
    const my = (m: number) => LAT_A + m / 111_200;
    const els: OsmElement[] = [
      { type: "node", id: 1, lon: mx(0), lat: my(-200) },
      { type: "node", id: 2, lon: mx(0), lat: my(0) },
      { type: "node", id: 3, lon: mx(400), lat: my(0) },
      {
        type: "way",
        id: 1,
        nodes: [1, 2],
        tags: { highway: "service", psv: "yes" },
      },
      {
        type: "way",
        id: 2,
        nodes: [2, 3],
        tags: { highway: "service", psv: "yes", oneway: "yes" },
      },
    ];
    for (const [w, north] of [
      [3, 10],
      [4, 14],
    ] as const) {
      const ids: number[] = [];
      for (let m = -100; m <= 500; m += 4) {
        const id = w * 1000 + ids.length;
        els.push({ type: "node", id, lon: mx(m), lat: my(north) });
        ids.push(id);
      }
      els.push({
        type: "way",
        id: w,
        nodes: ids,
        tags: { highway: "motorway" },
      });
    }
    const rg = RoadGraph.fromOsm(els);
    const m = matchShape(rg, [
      [mx(0), my(-200)],
      [mx(20), my(10)],
      [mx(400), my(10)],
    ]);
    expect(m.pieces.some((p) => "raw" in p)).toBe(false);
    expect(m.coords.at(-1)![0]).toBeCloseTo(mx(400), 6);
    for (const [lo, la] of m.coords)
      if (lo > mx(1)) expect(Math.abs(la - my(0))).toBeLessThan(1e-6);
  });

  it("stays on the road where the shape repeats a point a little behind", () => {
    // GTFS shapes repeat points, and the repeat can project a few centimetres back along the edge.
    const m = matchShape(g, [
      [lon(0), LAT_A],
      [lon(1.5), LAT_A],
      [lon(1.5) - 0.0000007, LAT_A],
      [lon(4), LAT_A],
    ]);
    expect(m.pieces.some((p) => "raw" in p)).toBe(false);
    for (const [, la] of m.coords)
      expect(Math.abs(la - LAT_A)).toBeLessThan(1e-6);
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

  it("doesn't chain a one-way loop into a two-way street with the same routes", () => {
    // A terminal loop (both patterns run the same way around) joined end to end to a two-way
    // street where they run opposite ways: same patterns, different directions (the 16 at Arbutus).
    const merged = mergeCarriageways([
      {
        coords: [
          [x(0), y(0)],
          [x(300), y(0)],
        ],
        refs: [
          [0, 1, 0],
          [1, 1, 900],
        ],
      },
      {
        coords: [
          [x(300), y(0)],
          [x(800), y(0)],
        ],
        refs: [
          [0, 1, 300],
          [1, -1, 0],
        ],
      },
    ]);
    const street = merged.filter((c) => c.coords.some(([lo]) => lo > x(400)));
    expect(street.length).toBeGreaterThan(0);
    for (const c of street)
      expect(new Set(c.refs.map(([, d]) => d)).size).toBe(2);
  });

  it("keeps one line where the carriageways spread apart for a stretch", () => {
    // 20 m apart, then 60 m apart for 60 m (round a bend, the R4 onto 16th Avenue at UBC), then 20 m.
    const spread = (sign: 1 | -1): LonLat[] => [
      [x(0), y(10 * sign)],
      [x(300), y(10 * sign)],
      [x(320), y(30 * sign)],
      [x(380), y(30 * sign)],
      [x(400), y(10 * sign)],
      [x(700), y(10 * sign)],
    ];
    const merged = mergeCarriageways([
      { coords: spread(1), refs: [[0, 1, 0]] },
      { coords: spread(-1).reverse(), refs: [[1, 1, 0]] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.refs).toHaveLength(2);
    for (const [, la] of merged[0]!.coords)
      expect(Math.abs(la - LAT_A) * 111_200).toBeLessThan(2);
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

  it("counts trips starting in the hour from a time", () => {
    expect(freq.perHour(wed, "now", 12 * 3600)[0]).toBe(6);
    expect(freq.perHour(wed, "now", 12 * 3600 + 60)[0]).toBe(6);
  });

  it("averages over the day, 06:00–21:00", () => {
    // Every 10 min from 06:00 to 20:50: 90 trips over 15 h; the evening's hourly trips don't count.
    expect(freq.perHour(wed, "day", 0)[0]).toBeCloseTo(6, 5);
  });

  it("counts a trip of the next service day by when it runs", () => {
    // Thursday's service with one trip at 00:15 (a service day that starts at midnight).
    const early = {
      ...plan,
      trips: [
        ...plan.trips,
        {
          id: "x",
          pattern: 0,
          service: "thu",
          headsign: "",
          start: 900,
          arr: [0, 600],
        },
      ],
      calendar: {
        ...plan.calendar,
        exceptions: [
          { serviceId: "thu", date: serviceDate("20261022"), type: 1 as const },
        ],
      },
    } as unknown as ServicePlan;
    // The hour from Wednesday's 24:00: its 24:30 trip and Thursday's 00:15.
    expect(new BusFrequency(early).perHour(wed, "now", 24 * 3600)[0]).toBe(2);
  });

  it("has nothing on days without service", () => {
    expect(freq.perHour(serviceDate("20261024"), "now", 12 * 3600)[0]).toBe(0);
  });
});
