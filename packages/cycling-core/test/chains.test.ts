import { describe, expect, it } from "vitest";
import { joinChains, type ClassifiedWay } from "../src/chains.ts";

type A = { kind: string; oneway?: boolean };

/** A way along node ids, each node n at (n, 0). */
const way = (id: number, nodes: number[], attrs: A): ClassifiedWay<A> => ({
  id,
  nodes,
  coords: nodes.map((n) => [n, 0]),
  attrs,
});
const join = (ways: ClassifiedWay<A>[]) =>
  joinChains(
    ways,
    (a) => a.kind,
    (a) => a.oneway === true,
  ).map((c) => ({ ways: c.wayIds, nodes: c.coords.map((p) => p[0]) }));

const path = { kind: "path" };
const lane = { kind: "lane" };
const oneway = { kind: "lane", oneway: true };

describe("joinChains", () => {
  it("joins ways end to end, turning them around as needed", () => {
    expect(
      join([way(1, [1, 2], path), way(2, [3, 2], path), way(3, [3, 4], path)]),
    ).toEqual([{ ways: [1, 2, 3], nodes: [1, 2, 3, 4] }]);
  });

  it("joins backwards from the first way too", () => {
    expect(join([way(2, [2, 3], path), way(1, [1, 2], path)])).toEqual([
      { ways: [1, 2], nodes: [1, 2, 3] },
    ]);
  });

  it("doesn't join ways with different attributes", () => {
    expect(join([way(1, [1, 2], path), way(2, [2, 3], lane)])).toHaveLength(2);
  });

  it("breaks at a junction of three ways, and where another way passes through", () => {
    expect(
      join([way(1, [1, 2], path), way(2, [2, 3], path), way(3, [2, 9], path)]),
    ).toHaveLength(3);
    expect(
      join([
        way(1, [1, 2], path),
        way(2, [2, 3], path),
        way(3, [8, 2, 9], lane),
      ]),
    ).toHaveLength(3);
  });

  it("joins one-way ways only head to tail, keeping their direction", () => {
    expect(join([way(1, [1, 2], oneway), way(2, [2, 3], oneway)])).toEqual([
      { ways: [1, 2], nodes: [1, 2, 3] },
    ]);
    expect(join([way(1, [1, 2], oneway), way(2, [3, 2], oneway)])).toHaveLength(
      2,
    );
  });

  it("stops going round a loop", () => {
    expect(
      join([way(1, [1, 2], path), way(2, [2, 3], path), way(3, [3, 1], path)]),
    ).toEqual([{ ways: [1, 2, 3], nodes: [1, 2, 3, 1] }]);
    expect(join([way(1, [1, 2, 3, 1], path)])).toEqual([
      { ways: [1], nodes: [1, 2, 3, 1] },
    ]);
  });
});
