import { describe, expect, it } from "vitest";
import type { LayerSpecification, Map as MlMap } from "maplibre-gl";
import { addFeedLayer, firstFeedLayer } from "../src/layers/order.ts";

/** The layer order of a map, and just enough of a map to change it. */
function fakeMap(initial: string[]) {
  const order = [...initial];
  const map = {
    getLayersOrder: () => [...order],
    addLayer: (layer: LayerSpecification, before?: string) => {
      const i = before === undefined ? -1 : order.indexOf(before);
      order.splice(i < 0 ? order.length : i, 0, layer.id);
    },
  } as unknown as MlMap;
  const add = (id: string) =>
    addFeedLayer(map, { id, type: "background" } as LayerSpecification);
  return { map, order, add };
}

describe("addFeedLayer", () => {
  it("stacks every feed's layers by type, whatever order feeds add them in", () => {
    const { order, add } = fakeMap(["water", "roads"]);
    for (const name of ["routes-bus", "routes-shape", "stations-label"])
      add(`a/${name}`);
    for (const name of ["stations-label", "routes-shape", "routes-bus"])
      add(`b/${name}`);
    expect(order).toEqual([
      "water",
      "roads",
      "a/routes-bus",
      "b/routes-bus",
      "a/routes-shape",
      "b/routes-shape",
      "a/stations-label",
      "b/stations-label",
    ]);
  });

  it("keeps the engine's own layers between feeds' where they were put", () => {
    const { map, order, add } = fakeMap([]);
    add("a/stations");
    add("a/bus-stops-label");
    order.splice(order.indexOf("a/bus-stops-label"), 0, "vehicles");
    // A second feed's stations go beneath the vehicles, its labels above them.
    add("b/bus-stops-label");
    add("b/stations");
    expect(order).toEqual([
      "a/stations",
      "b/stations",
      "vehicles",
      "a/bus-stops-label",
      "b/bus-stops-label",
    ]);
    expect(firstFeedLayer(map, "bus-stops-label")).toBe("a/bus-stops-label");
    expect(firstFeedLayer(map, "exchanges")).toBe("a/stations");
  });
});
