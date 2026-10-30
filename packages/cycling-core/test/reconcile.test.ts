import { describe, expect, it } from "vitest";
import { reconcileRoutes, type RegisteredRoute } from "../src/reconcile.ts";

const route = (
  id: string,
  relation: number,
  more: Partial<RegisteredRoute> = {},
): RegisteredRoute => ({
  id,
  relation,
  name: "Seaside Greenway",
  status: "active",
  ...more,
});

describe("reconcileRoutes", () => {
  it("mints new relations, keeps known ones and follows OSM's names", () => {
    const d = reconcileRoutes(
      [route("cr-a", 1), route("cr-b", 2, { name: "Old" })],
      new Map([
        [3, "Central Valley Greenway"],
        [2, "BC Parkway"],
        [1, "Seaside Greenway"],
      ]),
    );
    expect(d).toEqual({
      mint: [{ relation: 3, name: "Central Valley Greenway" }],
      rename: [{ id: "cr-b", name: "BC Parkway" }],
      reactivate: [],
      retire: [],
    });
  });

  it("retires routes that left OSM and brings them back when they return", () => {
    const d = reconcileRoutes(
      [route("cr-a", 1), route("cr-b", 2, { status: "retired" })],
      new Map([[2, "Seaside Greenway"]]),
    );
    expect(d.retire).toEqual(["cr-a"]);
    expect(d.reactivate).toEqual(["cr-b"]);
    expect(d.mint).toEqual([]);
  });

  it("keeps an admin's name", () => {
    const d = reconcileRoutes(
      [route("cr-a", 1, { nameLocked: true })],
      new Map([[1, "Seawall"]]),
    );
    expect(d.rename).toEqual([]);
  });
});
