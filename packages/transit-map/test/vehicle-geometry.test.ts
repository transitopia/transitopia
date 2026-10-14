import { describe, expect, it } from "vitest";
import {
  distToPolyline,
  extendEnds,
  hexToRgb,
  inset,
  mercX,
  mercY,
  pointInConvex,
  ribbon,
  vehicleOutline,
} from "../src/layers/vehicle-geometry.ts";
import type { VehicleState } from "@transitopia/transit-core/schedule/engine.ts";

const xy = (a: Float64Array) =>
  Array.from({ length: a.length / 2 }, (_, i) => [a[i * 2]!, a[i * 2 + 1]!]);

describe("ribbon", () => {
  // A straight line along x, 10 units long, half-width 1, with a nose over the last 2 units.
  const line = new Float64Array([0, 0, 5, 0, 8, 0, 10, 0]);
  const { left, right } = ribbon(line, 1, 2);

  it("offsets each vertex by the half-width on either side, tail first", () => {
    expect(xy(left).slice(0, 2)).toEqual([
      [0, 1],
      [5, 1],
    ]);
    expect(xy(right).slice(0, 2)).toEqual([
      [0, -1],
      [5, -1],
    ]);
  });

  it("is full width up to the nose and tapers to a fifth at the head", () => {
    expect(left[5]).toBeCloseTo(1); // 2 from the head: where the nose starts
    expect(left[7]).toBeCloseTo(0.2);
    expect(right[7]).toBeCloseTo(-0.2);
  });

  it("follows a bend with the vertex normal averaged over both segments", () => {
    const bend = ribbon(new Float64Array([0, 0, 10, 0, 10, 10]), 1, 1e-9);
    // At the corner the direction is (1, 1)/√2, so the left offset is (−1, 1)/√2.
    expect(bend.left[2]).toBeCloseTo(10 - Math.SQRT1_2);
    expect(bend.left[3]).toBeCloseTo(Math.SQRT1_2);
    expect(bend.right[2]).toBeCloseTo(10 + Math.SQRT1_2);
    expect(bend.right[3]).toBeCloseTo(-Math.SQRT1_2);
  });
});

describe("extendEnds", () => {
  it("moves both ends outward along their segments and leaves the rest", () => {
    const out = extendEnds(new Float64Array([0, 0, 5, 0, 5, 5]), 1);
    expect(xy(out)).toEqual([
      [-1, 0],
      [5, 0],
      [5, 6],
    ]);
  });

  it("leaves a single point alone", () => {
    expect(Array.from(extendEnds(new Float64Array([3, 4]), 1))).toEqual([3, 4]);
  });
});

describe("inset", () => {
  it("shrinks a square by d on every side, whichever way it winds", () => {
    const ccw = new Float64Array([0, 0, 4, 0, 4, 4, 0, 4]);
    const cw = new Float64Array([0, 0, 0, 4, 4, 4, 4, 0]);
    const round = (a: Float64Array) =>
      xy(a).map(([x, y]) => [
        Math.round(x! * 1e9) / 1e9,
        Math.round(y! * 1e9) / 1e9,
      ]);
    expect(round(inset(ccw, 1))).toEqual([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
    expect(round(inset(cw, 1))).toEqual([
      [1, 1],
      [1, 3],
      [3, 3],
      [3, 1],
    ]);
  });
});

describe("picking", () => {
  it("measures distance to the nearest segment", () => {
    const line = new Float64Array([0, 0, 10, 0, 10, 10]);
    expect(distToPolyline(line, 5, 3)).toBeCloseTo(3);
    expect(distToPolyline(line, 12, 5)).toBeCloseTo(2);
    expect(distToPolyline(line, -3, -4)).toBeCloseTo(5); // past the tail
  });

  it("tests points against a convex polygon, edges included", () => {
    const tri = new Float64Array([0, 0, 4, 0, 0, 4]);
    expect(pointInConvex(tri, 1, 1)).toBe(true);
    expect(pointInConvex(tri, 2, 0)).toBe(true);
    expect(pointInConvex(tri, 3, 3)).toBe(false);
  });
});

describe("vehicleOutline", () => {
  const v = { lat: 0, lon: 0, bearing: 90 } as VehicleState;
  const perM = 1 / 40_075_016.686;

  it("is a pointed rectangle facing the bearing, centred on the vehicle", () => {
    const pts = xy(vehicleOutline(v, 20, 4)).map(([x, y]) => [
      Math.round((x! - 0.5) / perM),
      Math.round((y! - 0.5) / perM),
    ]);
    // Heading east: the tail at x = −10, the tip at x = +10 after a 3.6 m nose (0.9 × the
    // width); the right side is south, +y in mercator.
    expect(pts).toEqual([
      [-10, -2],
      [-10, 2],
      [6, 2],
      [10, 0],
      [6, -2],
    ]);
  });
});

describe("mercator", () => {
  it("maps lon/lat to 0–1 with y growing southward", () => {
    expect(mercX(-180)).toBe(0);
    expect(mercX(0)).toBe(0.5);
    expect(mercY(0)).toBeCloseTo(0.5);
    expect(mercY(49.28)).toBeLessThan(0.5);
  });

  it("parses route colours", () => {
    expect(hexToRgb("#0060A9")).toEqual([0, 96, 169]);
  });
});
