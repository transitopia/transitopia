import { describe, expect, it } from "vitest";
import { creditsFor, legendsFor } from "../src/datasets.ts";

describe("creditsFor", () => {
  it("returns visible datasets once each, in registry order", () => {
    const ids = creditsFor(["translink-gtfs", "osm", "osm", "nope"]).map(
      (d) => d.id,
    );
    expect(ids).toEqual(["osm", "translink-gtfs"]);
  });
});

describe("legendsFor", () => {
  it("shows TransLink's required legend once for schedule and real-time data", () => {
    const legends = legendsFor(
      creditsFor(["translink-gtfs", "translink-gtfs-rt"]),
    );
    expect(legends).toHaveLength(1);
    expect(legends[0]).toMatch(/provided by permission of TransLink/);
  });
});
