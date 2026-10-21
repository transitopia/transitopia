import { describe, expect, it } from "vitest";
import { planTileFeatures } from "@transitopia/transit-core/plan/tiles.ts";
import type {
  PlanCorridor,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import { tileInput } from "../src/plan-tiles.ts";

const line = (lat: number): PlanCorridor["coords"] => [
  [-123.1, lat],
  [-123.09, lat],
];
const plan = (corridors: PlanCorridor[]): ServicePlan =>
  ({
    routes: [],
    patterns: [],
    shapes: {},
    trips: [],
    corridors,
  }) as unknown as ServicePlan;

describe("plan tile input", () => {
  it("is the same whatever order the features come in", () => {
    const a = planTileFeatures(plan([{ coords: line(49.3) }]));
    expect(tileInput([...a].reverse())).toBe(tileInput(a));
  });

  // build-schedule numbers corridors by their geometry, breaking ties by their patterns, whose
  // indices can change between feed versions: two corridors with the same geometry can swap ids.
  it("doesn't change when corridors with the same geometry swap ids", () => {
    const same = line(49.31);
    const before = plan([
      { coords: line(49.3), refs: [[0, 1, 0]] },
      { coords: same, refs: [[1, 1, 0]] },
      { coords: same, refs: [[2, 1, 0]] },
    ]);
    const after = plan([
      { coords: line(49.3), refs: [[0, 1, 0]] },
      { coords: same, refs: [[2, 1, 0]] },
      { coords: same, refs: [[1, 1, 0]] },
    ]);
    expect(tileInput(planTileFeatures(after))).toBe(
      tileInput(planTileFeatures(before)),
    );
  });
});
