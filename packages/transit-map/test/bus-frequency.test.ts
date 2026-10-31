import { describe, expect, it } from "vitest";
import type { Map as MlMap } from "maplibre-gl";
import type {
  CorridorSet,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import { serviceDate } from "@transitopia/transit-core/time.ts";
import { PLAN_TILE_LAYERS } from "@transitopia/transit-core/plan/tiles.ts";
import { BusFrequencyLayer } from "../src/layers/bus-frequency.ts";

// Two routes on corridors of their own: the R2 (its own colour) and the 19 (regular), each every
// 10 minutes all day.
const starts = { wk: Array.from({ length: 90 }, (_, i) => 6 * 3600 + i * 600) };
const corridors = (...combo: number[]): CorridorSet => ({ combo, short: [] });
const plan = (cs: CorridorSet): ServicePlan =>
  ({
    feedStart: serviceDate("20261001"),
    feedEnd: serviceDate("20261031"),
    routes: [
      { key: "R2", kind: "bus", brand: true },
      { key: "19", kind: "bus", brand: false },
    ],
    stops: [],
    stations: [],
    shapes: {},
    patterns: [
      {
        id: 0,
        route: "R2",
        direction: 0,
        shape: "a",
        stops: [],
        dist: [],
        starts,
      },
      {
        id: 1,
        route: "19",
        direction: 0,
        shape: "b",
        stops: [],
        dist: [],
        starts,
      },
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
    corridorInfo: { detailed: cs, overview: cs },
  }) as unknown as ServicePlan;

/** A map that keeps the feature state set since the last removal, as MapLibre's queue would. */
function fakeMap() {
  const set = new Map<string, Map<number, Record<string, unknown>>>();
  const calls: Record<string, unknown>[] = [];
  const map = {
    getSource: () => ({}),
    setFeatureState(
      {
        sourceLayer,
        source,
        id,
      }: { source: string; sourceLayer?: string; id: number },
      state: Record<string, unknown>,
    ) {
      calls.push(state);
      const key = sourceLayer ?? source;
      if (!set.has(key)) set.set(key, new Map());
      const s = set.get(key)!;
      s.set(id, { ...s.get(id), ...state });
    },
    removeFeatureState({
      source,
      sourceLayer,
    }: {
      source: string;
      sourceLayer?: string;
    }) {
      set.delete(sourceLayer ?? source);
    },
  };
  return { map: map as unknown as MlMap, set, calls };
}

describe("BusFrequencyLayer", () => {
  it("sets every corridor's brand after its data is replaced", () => {
    const { map, set } = fakeMap();
    const update = (layer: BusFrequencyLayer) =>
      layer.update(
        map,
        serviceDate("20261019"),
        8 * 3600,
        "day",
        new Set(),
        undefined,
      );
    const before = new BusFrequencyLayer(plan(corridors(0, 1)));
    before.invalidate(map);
    update(before);
    expect(set.get(PLAN_TILE_LAYERS.corridors)?.get(0)?.["brand"]).toBe(0);

    // Another plan's tiles, numbered differently: corridor 0 is now the 19's. MapLibre may still
    // apply the old plan's queued brand (packages/transit-map/src/layers/bus-frequency.ts →
    // invalidate), unless the new state sets one explicitly.
    const after = new BusFrequencyLayer(plan(corridors(1, 0)));
    after.invalidate(map);
    update(after);
    const detailed = set.get(PLAN_TILE_LAYERS.corridors)!;
    expect(detailed.get(0)?.["brand"]).toBe(-1);
    expect(detailed.get(1)?.["brand"]).toBe(0);
  });

  it("sets only the state that changed", () => {
    const { map, set, calls } = fakeMap();
    const layer = new BusFrequencyLayer(plan(corridors(0, 1)));
    layer.invalidate(map);
    const update = (seconds: number, hidden = new Set<string>()) => {
      calls.length = 0;
      layer.update(
        map,
        serviceDate("20261019"),
        seconds,
        "now",
        hidden,
        undefined,
      );
      return calls.length;
    };
    // Two corridors (both sets) and no stops: each feature once.
    expect(update(8 * 3600)).toBe(4);
    // Another five-minute step, every 10 minutes as before.
    expect(update(8 * 3600 + 300)).toBe(0);
    // Hiding the 19 idles its corridors and nothing else.
    expect(update(8 * 3600 + 300, new Set(["19"]))).toBe(2);
    const detailed = set.get(PLAN_TILE_LAYERS.corridors)!;
    expect(detailed.get(1)).toMatchObject({ tier: -1, idle: false, brand: -1 });
    expect(detailed.get(0)).toMatchObject({ brand: 0, dim: false });
    // After the sources are replaced, everything again.
    layer.invalidate(map);
    expect(update(8 * 3600 + 300, new Set(["19"]))).toBe(4);
  });
});
