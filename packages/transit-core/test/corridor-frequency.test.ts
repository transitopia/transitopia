import { describe, expect, it } from "vitest";
import {
  capShort,
  CorridorFrequency,
  shortCorridorNeighbours,
} from "../src/plan/corridor-frequency.ts";
import type { PlanCorridor, ServicePlan } from "../src/plan/types.ts";

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
const plan = {
  stops: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, name: `S${i}` })),
  patterns: [
    pattern(0, "A", 0, [0, 1, 2, 3, 4]),
    pattern(1, "B", 0, [1, 2, 3, 4]),
    pattern(2, "C", 0, [1, 2, 5]),
    pattern(3, "A", 1, [4, 3, 2, 1, 0]),
    pattern(4, "A", 0, [2, 3]),
  ],
  trips: [0, 1, 2, 3, 4].map((p) => ({
    id: `t${p}`,
    pattern: p,
    service: "wk",
    headsign: `to ${p}`,
    start: 0,
    arr: [],
  })),
  calendar: { calendar: [], exceptions: [] },
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
  // Trips an hour: A 3 (and its variant 0.2), B 3, C 4, A westbound 2.
  const perHour = Float64Array.from([3, 3, 4, 2, 0.2]);
  const best = (c: PlanCorridor) => {
    const combo = cf.combosOfCorridors([c])[0]!;
    return cf.rates(perHour, () => true).best[combo]!;
  };

  it("adds up routes only where they share a stretch, as stop cards do", () => {
    // Between stops 2 and 3: A (3.2 with its variant) and B (3) share 1 → 4, three stops.
    expect(
      best(
        corridor([
          [0, 650],
          [1, 350],
        ]),
      ),
    ).toBeCloseTo(6.2, 5);
    // Between stops 1 and 2, C runs with them too, but leaves after one stop (300 m): not added.
    expect(
      best(
        corridor([
          [0, 350],
          [1, 50],
          [2, 50],
        ]),
      ),
    ).toBeCloseTo(6.2, 5);
    expect(
      best(
        corridor([
          [0, 350],
          [2, 50],
        ]),
      ),
    ).toBeCloseTo(4, 5);
    // Before stop 1, only A.
    expect(best(corridor([[0, 50]]))).toBeCloseTo(3.2, 5);
  });

  it("gives a route its busier direction's frequency wherever most of its trips pass", () => {
    // A eastbound runs 3 an hour, plus 0.2 on its variant: 3.2 everywhere, with or without it.
    expect(best(corridor([[0, 50]]))).toBeCloseTo(3.2, 5);
    expect(
      best(
        corridor([
          [0, 650],
          [4, 50],
        ]),
      ),
    ).toBeCloseTo(3.2, 5);
    // The variant alone runs at its own rate.
    expect(best(corridor([[4, 50]]))).toBeCloseTo(0.2, 5);
    // Westbound A (2 an hour) shows A's busier direction.
    expect(best(corridor([[3, 50]]))).toBeCloseTo(3.2, 5);
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
    const c = cf.combosOfCorridors([
      corridor([
        [0, 650],
        [1, 350],
      ]),
    ])[0]!;
    expect(cf.rates(perHour, (r) => r !== "B").best[c]).toBeCloseTo(3.2, 5);
  });

  it("colours a stop by the best of what its card lists", () => {
    const [s1, s5] = cf.combosOfStops([1, 5]);
    // From stop 1: A + B together (6.2), or C on its own (4).
    expect(cf.rates(perHour, () => true).best[s1!]).toBeCloseTo(6.2, 5);
    // Nothing leaves stop 5; C arrives there.
    expect(cf.rates(perHour, () => true).best[s5!]).toBeCloseTo(4, 5);
  });
});

describe("capShort", () => {
  it("caps a short corridor at its busiest neighbour", () => {
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
    expect([...capShort(Float32Array.from([2, 9, 3]), nb)]).toEqual([2, 3, 3]);
  });
});
