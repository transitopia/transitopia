import { describe, expect, it } from "vitest";
import type { Map as MlMap } from "maplibre-gl";
import type { PlanCorridor, ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import { BusFrequencyLayer } from "../src/layers/bus-frequency.ts";
import { CORRIDORS_SOURCE } from "../src/layers/static.ts";

// Two routes on corridors of their own: the R2 (its own colour) and the 19 (regular), each every
// 10 minutes all day.
const starts = { wk: Array.from({ length: 90 }, (_, i) => 6 * 3600 + i * 600) };
const corridor = (combo: number, lat: number): PlanCorridor => ({
  coords: [
    [-123.1, lat],
    [-123.09, lat],
  ],
  combo,
});
const plan = (): ServicePlan =>
  ({
    routes: [
      { key: "R2", kind: "bus", category: "frequent" },
      { key: "19", kind: "bus", category: "regular" },
    ],
    stops: [],
    stations: [],
    shapes: {},
    patterns: [
      { id: 0, route: "R2", direction: 0, shape: "a", stops: [], dist: [], starts },
      { id: 1, route: "19", direction: 0, shape: "b", stops: [], dist: [], starts },
    ],
    trips: [],
    calendar: {
      calendar: [
        {
          serviceId: "wk",
          days: Array(7).fill(true),
          start: serviceDate("20260101"),
          end: serviceDate("20271231"),
        },
      ],
      exceptions: [],
    },
    frequency: {
      routeDirs: [
        { route: "R2", patterns: [0] },
        { route: "19", patterns: [1] },
      ],
      combos: [
        { units: [{ routeDir: 0, patterns: [0] }], bundles: [] },
        { units: [{ routeDir: 1, patterns: [1] }], bundles: [] },
      ],
      stopCombo: [],
    },
    // Until the detailed corridors load, the overview's stand in for them.
    overviewCorridors: [corridor(0, 49.3), corridor(1, 49.31)],
  }) as unknown as ServicePlan;

/** A map that keeps the feature state set since the last removal, as MapLibre's queue would. */
function fakeMap() {
  const set = new Map<string, Map<number, Record<string, unknown>>>();
  const map = {
    getSource: () => ({}),
    setFeatureState(
      { source, id }: { source: string; id: number },
      state: Record<string, unknown>,
    ) {
      if (!set.has(source)) set.set(source, new Map());
      const s = set.get(source)!;
      s.set(id, { ...s.get(id), ...state });
    },
    removeFeatureState({ source }: { source: string }) {
      set.delete(source);
    },
  };
  return { map: map as unknown as MlMap, set };
}

describe("BusFrequencyLayer", () => {
  it("sets every corridor's brand after its data is replaced", () => {
    const p = plan();
    const { map, set } = fakeMap();
    const update = (layer: BusFrequencyLayer) =>
      layer.update(map, serviceDate("20261019"), 8 * 3600, "day", new Set(), undefined);
    const before = new BusFrequencyLayer(p);
    before.invalidate(map);
    update(before);
    expect(set.get(CORRIDORS_SOURCE)?.get(0)?.["brand"]).toBe(0);

    // The detailed corridors arrive, numbered differently: corridor 0 is now the 19's. MapLibre
    // may still apply the stand-in's queued brand (packages/transit-map/src/layers/bus-frequency.ts
    // → invalidate), unless the new state sets one explicitly.
    p.corridors = [corridor(1, 49.31), corridor(0, 49.3)];
    const after = new BusFrequencyLayer(p);
    after.invalidate(map);
    update(after);
    const detailed = set.get(CORRIDORS_SOURCE)!;
    expect(detailed.get(0)?.["brand"]).toBe(-1);
    expect(detailed.get(1)?.["brand"]).toBe(0);
  });
});
