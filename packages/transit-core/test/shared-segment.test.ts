import { describe, expect, it } from "vitest";
import {
  segmentSteps,
  segmentFrequency,
  segmentStarts,
  segmentStops,
  sharedSegment,
  sharedStart,
  startOffsets,
} from "../src/schedule/shared-segment.ts";
import { indexCalendar } from "../src/gtfs/calendar.ts";
import {
  patternStarts,
  type PathStep,
  type ServicePlan,
} from "../src/plan/types.ts";
import { serviceDate } from "../src/time.ts";

// A and B come together at S1 (from S0 and Y) and run to S4, where they split; C runs S1 to S4 too
// (a night route, say), and D leaves S1 another way. E and F start from two bays of an exchange
// (X0, X1) and share from S1.
const DATE = serviceDate("20260926"); // a Saturday
const H8 = 8 * 3600;
const ids = [
  "S0",
  "Y",
  "S1",
  "S2",
  "S3",
  "S4",
  "Ea",
  "Eb",
  "Ec",
  "S5",
  "X0",
  "X1",
];
const at = (id: string) => ids.indexOf(id);
const pattern = (id: number, route: string, stops: string[]) => ({
  id,
  route,
  direction: 0,
  shape: "s",
  stops: stops.map(at),
  dist: stops.map((_, i) => i * 100),
});
const plan: ServicePlan = {
  schema: 1,
  feed: "translink",
  feedVersion: "test",
  feedStart: serviceDate("20260901"),
  feedEnd: serviceDate("20261231"),
  timezone: "America/Vancouver",
  builtAt: "",
  routes: ["A", "B", "C", "D", "E", "F"].map((key) => ({
    key,
    label: key,
    kind: "bus" as const,
    mode: "bus" as const,
    brand: false,
    color: "#000",
    textColor: "#fff",
    gtfsRouteId: key,
  })),
  stops: ids.map((id, i) => ({ id, name: id, lon: -123 + i * 0.001, lat: 49 })),
  stations: [],
  hubs: [],
  shapes: {
    s: Array.from(
      { length: 7 },
      (_, i) => [-123 + i * 0.00137, 49] as [number, number],
    ),
  },
  patterns: [
    pattern(0, "A", ["S0", "S1", "S2", "S3", "S4", "Ea"]),
    pattern(1, "B", ["Y", "S1", "S2", "S3", "S4", "Eb"]),
    pattern(2, "C", ["S1", "S2", "S3", "S4", "Ec"]),
    pattern(3, "D", ["S0", "S1", "S5"]),
    pattern(4, "E", ["X0", "S1", "S2", "S3"]),
    pattern(5, "F", ["X1", "S1", "S2", "S3"]),
  ],
  trips: [
    // A every 20 min from 08:00, two minutes to S1; B every 20 min from 08:11, one minute to S1:
    // together, a bus from S1 every 10 minutes from 08:02.
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      pattern: 0,
      service: "sa",
      headsign: "Ea",
      start: H8 + i * 1200,
      arr: [0, 120, 240, 360, 480, 600],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      pattern: 1,
      service: "sa",
      headsign: "Eb",
      start: H8 + 660 + i * 1200,
      arr: [0, 60, 180, 300, 420, 540],
    })),
  ],
  calendar: {
    calendar: [
      {
        serviceId: "sa",
        days: [false, false, false, false, false, true, false],
        start: serviceDate("20260901"),
        end: serviceDate("20261231"),
      },
    ],
    exceptions: [],
  },
};

describe("sharedStart", () => {
  it("walks back to where every member came from the same stop", () => {
    // A and B leaving S3 together: they've been together since S1.
    expect(
      sharedStart(plan, [
        { pattern: 0, index: 3 },
        { pattern: 1, index: 3 },
      ]),
    ).toBe("S1");
    expect(
      sharedStart(plan, [
        { pattern: 0, index: 1 },
        { pattern: 1, index: 1 },
      ]),
    ).toBe("S1");
  });

  it("starts at the next stop when members leave from different stops (an exchange's bays)", () => {
    expect(
      sharedStart(plan, [
        { pattern: 4, index: 0 },
        { pattern: 5, index: 0 },
      ]),
    ).toBe("S1");
  });
});

describe("bays of one exchange (placeOf)", () => {
  // X0 and X1 are bays of one exchange.
  const placeOf = (id: string) =>
    id === "X0" || id === "X1" ? "exchange" : id;

  it("start at the exchange, named by one of its bays", () => {
    expect(
      sharedStart(
        plan,
        [
          { pattern: 4, index: 0 },
          { pattern: 5, index: 0 },
        ],
        placeOf,
      ),
    ).toBe("X0");
  });

  it("match from any of its bays", () => {
    expect(sharedSegment(plan, "X1", "S3", placeOf)!.patterns).toEqual([
      { pattern: 4, from: 0, to: 3 },
      { pattern: 5, from: 0, to: 3 },
    ]);
    expect(sharedSegment(plan, "X0", "X1", placeOf)).toBeUndefined();
  });
});

describe("sharedSegment", () => {
  it("has every pattern running between its ends through the same stops", () => {
    const seg = sharedSegment(plan, "S1", "S4")!;
    expect(seg.routes).toEqual(["A", "B", "C"]);
    expect(seg.patterns).toEqual([
      { pattern: 0, from: 1, to: 4 },
      { pattern: 1, from: 1, to: 4 },
      { pattern: 2, from: 0, to: 3 },
    ]);
    expect([...segmentStops(plan, seg)].map((s) => ids[s])).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
    ]);
  });

  it("is undefined when nothing runs from one end to the other", () => {
    expect(sharedSegment(plan, "S4", "S1")).toBeUndefined();
    expect(sharedSegment(plan, "S5", "S4")).toBeUndefined();
  });

  it("merges its buses' departures from its start", () => {
    const seg = sharedSegment(plan, "S1", "S4")!;
    const offsets = startOffsets(seg, plan.trips);
    // C has no trips here: no offset to learn.
    expect(offsets).toEqual([120, 60, 0]);
    const f = segmentFrequency(
      indexCalendar(plan.calendar),
      segmentStarts(seg, patternStarts(plan), offsets),
      DATE,
      H8 + 120,
      3600,
    )!;
    expect(f.wait).toBe(10);
    expect(f.departures).toBe(6);
  });
});

describe("segmentSteps", () => {
  it("keeps the features a segment covers half of", () => {
    const seg = sharedSegment(plan, "S1", "S4")!;
    // Along A (S1 at 100 m, S4 at 400 m): 0–100 (before), 100–350, then 350–600 (its middle past
    // S4); B along the second too; D's own.
    const paths: Record<number, PathStep[]> = {
      0: [
        [0, 0, 100],
        [1, 100, 350],
        [2, 350, 600],
      ],
      1: [[1, 100, 350]],
      3: [[3, 100, 200]],
    };
    expect([...segmentSteps(plan, seg, (p) => paths[p])]).toEqual([1]);
  });

  it("keeps a long feature the segment starts partway along", () => {
    // From S2 (200 m along A) to S4 (400 m): A's first feature runs 0–300 m, its middle before
    // S2, but the segment covers 100 m of it; the next ends 20 m past S4.
    const seg = sharedSegment(plan, "S2", "S4")!;
    const path: PathStep[] = [
      [0, 0, 300],
      [1, 300, 420],
      [2, 420, 600],
    ];
    expect([...segmentSteps(plan, seg, (p) => (p === 0 ? path : []))]).toEqual([
      0, 1,
    ]);
  });

  it("keeps each time a pattern runs along a feature", () => {
    // A out along feature 5 and back along it within the segment (S1–S4, 100–400 m).
    const seg = sharedSegment(plan, "S1", "S4")!;
    const path: PathStep[] = [
      [5, 0, 90],
      [6, 90, 250],
      [5, 250, 340],
    ];
    expect(
      [...segmentSteps(plan, seg, (p) => (p === 0 ? path : []))].sort(
        (a, b) => a - b,
      ),
    ).toEqual([5, 6]);
  });
});
