import { describe, expect, it } from "vitest";
import {
  capShort,
  CorridorFrequency,
  shortCorridorNeighbours,
} from "../src/plan/corridor-frequency.ts";
import type { PlanCorridor, ServicePlan } from "../src/plan/types.ts";
import { serviceDate } from "../src/time.ts";

// Stops 0–5 along a street, 300 m apart. Pattern 0 (route A) and 1 (route B) run east together over
// stops 1–4; pattern 2 (route C) runs with them from stop 1 to stop 2 only, then turns off (stop 5).
// Pattern 3 is A's other direction; pattern 4 a variant of A eastbound from stop 2.
const pattern = (
  id: number,
  route: string,
  direction: number,
  stops: number[],
) => ({
  id,
  route,
  direction,
  shape: "s",
  stops,
  dist: stops.map((_, i) => i * 300),
});
const H8 = 8 * 3600;
/** Trips of a pattern from 08:00 (+ `first` min), `every` minutes apart, each stop `hops` s after the last. */
const trips = (
  p: number,
  first: number,
  every: number,
  n: number,
  hops: number[],
) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${p}.${i}`,
    pattern: p,
    service: "wk",
    headsign: `to ${p}`,
    start: H8 + first * 60 + i * every * 60,
    arr: hops.map((_, k) => hops.slice(0, k + 1).reduce((a, b) => a + b, 0)),
  }));
// Service runs from 08:00 to 10:00. A takes 10 minutes from stop 0 to stop 1, so it passes stop 1 at :10, :30, :50, with B, which
// starts there then: together they run every 20 minutes, though their starts are 10 apart.
const plan = {
  routes: [],
  feedStart: serviceDate("20261001"),
  feedEnd: serviceDate("20261031"),
  stops: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, name: `S${i}` })),
  patterns: [
    pattern(0, "A", 0, [0, 1, 2, 3, 4]),
    pattern(1, "B", 0, [1, 2, 3, 4]),
    pattern(2, "C", 0, [1, 2, 5]),
    pattern(3, "A", 1, [4, 3, 2, 1, 0]),
    pattern(4, "A", 0, [2, 3]),
  ],
  trips: [
    ...trips(0, 0, 20, 6, [0, 600, 60, 60, 60]),
    ...trips(1, 10, 20, 6, [0, 60, 60, 60]),
    ...trips(2, 0, 15, 8, [0, 60, 60]),
    ...trips(3, 0, 30, 4, [0, 60, 60, 60, 60]),
    ...trips(4, 5, 60, 1, [0, 60]),
  ],
  calendar: {
    calendar: [
      {
        serviceId: "wk",
        days: Array(7).fill(true),
        start: serviceDate("20261001"),
        end: serviceDate("20261031"),
      },
    ],
    exceptions: [],
  },
} as unknown as ServicePlan;

/** A corridor along the street, entered by each pattern `along` metres in. */
const corridor = (refs: [number, number][], lengthM = 100): PlanCorridor => ({
  coords: [
    [-123, 49.25],
    [-123 + lengthM / 72_700, 49.25],
  ],
  refs: refs.map(([p, along]) => [p, 1, along]),
});

describe("CorridorFrequency", () => {
  const cf = new CorridorFrequency(plan);
  const hour = { date: serviceDate("20261021"), from: H8, seconds: 3600 };
  // Worst waits from 08:00: A every 20 min (its variant 08:05 too), B 20, C 15, A westbound 30.
  const best = (c: PlanCorridor, include = (_: string) => true) => {
    const combo = cf.combosOfCorridors([c])[0]!;
    return cf.frequencies(hour, include).best[combo]!;
  };

  it("merges routes' departures only where they share a stretch, as stop cards do", () => {
    // Between stops 2 and 3: A and B share 1 → 4, three stops, passing together: every 20, not 10.
    expect(
      best(
        corridor([
          [0, 650],
          [1, 350],
        ]),
      ),
    ).toBe(20);
    // Between stops 1 and 2, C runs with them too, but leaves after one stop (300 m): its own 15.
    expect(
      best(
        corridor([
          [0, 350],
          [1, 50],
          [2, 50],
        ]),
      ),
    ).toBe(15);
    // Before stop 1, only A.
    expect(best(corridor([[0, 50]]))).toBe(20);
  });

  it("times a shared stretch's departures where they pass it", () => {
    const c = cf.combosOfCorridors([
      corridor([
        [0, 650],
        [1, 350],
      ]),
    ])[0]!;
    // A passes the corridor's middle ten minutes after it starts, B as it starts.
    expect(cf.combos[c]!.units.map((u) => u.offsets)).toEqual([[600], [0]]);
  });

  it("gives a route its better direction's frequency wherever most of its trips pass", () => {
    expect(
      best(
        corridor([
          [0, 650],
          [4, 50],
        ]),
      ),
    ).toBe(20);
    // The variant alone runs at its own: one trip at 08:05, then none that day, which counts as
    // an hour without service.
    expect(best(corridor([[4, 50]]))).toBe(60);
    // Westbound A (every 30) shows A's better direction.
    expect(best(corridor([[3, 50]]))).toBe(20);
  });

  it("gives corridors with the same services the same combo", () => {
    const [a, b] = cf.combosOfCorridors([
      corridor([
        [0, 650],
        [1, 350],
      ]),
      corridor(
        [
          [1, 400],
          [0, 700],
        ],
        50,
      ),
    ]);
    expect(a).toBe(b);
  });

  it("leaves out hidden routes", () => {
    const c = corridor([
      [0, 350],
      [1, 50],
      [2, 50],
    ]);
    expect(best(c, (r) => r !== "C")).toBe(20);
  });

  it("colours a stop by the best of what its card lists", () => {
    const [s1, s5] = cf.combosOfStops([1, 5]);
    const { best } = cf.frequencies(hour, () => true);
    // From stop 1: A + B together (every 20), or C on its own (15).
    expect(best[s1!]).toBe(15);
    // Nothing leaves stop 5; C arrives there.
    expect(best[s5!]).toBe(15);
  });

  it("has no frequency where nothing runs", () => {
    const { best, routeWaits } = cf.frequencies(
      { ...hour, from: 12 * 3600 },
      () => true,
    );
    expect(best[cf.combosOfCorridors([corridor([[0, 50]])])[0]!]).toBe(
      Infinity,
    );
    expect(routeWaits.get("A")).toBe(Infinity);
  });

  it("works out the week figure: each daytime hour's worst wait, an hour without service as 60", () => {
    const c = cf.combosOfCorridors([corridor([[0, 50]])])[0]!;
    // 08:00–09:00 has up to 20; 09:00–10:00 ends the day's service, which counts as 60, as do
    // the other 13 hours.
    const week = (14 * 60 + 20) / 15;
    expect(cf.frequencies("week", () => true).best[c]).toBeCloseTo(week, 4);
    expect(cf.combosWithWeek()[c]!.week).toBe(Math.round(week * 10) / 10);
  });
});

describe("capShort", () => {
  it("keeps a short corridor no more frequent than its best neighbour", () => {
    const line = (x0: number, x1: number): PlanCorridor => ({
      coords: [
        [x0, 49.25],
        [x1, 49.25],
      ],
      refs: [],
    });
    const cs = [line(0, 0.01), line(0.01, 0.0102), line(0.0102, 0.02)];
    const nb = shortCorridorNeighbours(cs);
    expect(nb).toEqual([[1, [0, 2]]]);
    // Worst waits: the short one's 2 becomes its best neighbour's 6.
    expect([...capShort(Float32Array.from([10, 2, 6]), nb)]).toEqual([
      10, 6, 6,
    ]);
  });
});
