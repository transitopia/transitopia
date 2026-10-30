import { describe, expect, it } from "vitest";
import { classifyWay, isBikeRoute, maxspeedKmh } from "../src/classify.ts";

const config = { calmMaxSpeedKmh: 30 };
const classify = (tags: Record<string, string>) => classifyWay(tags, config);

describe("classifyWay", () => {
  it("rates a cycleway the most comfortable, unless shared with pedestrians", () => {
    expect(classify({ highway: "cycleway" })).toEqual({
      class: "track",
      subclass: "cycleway",
      comfort: 4,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
    });
    expect(
      classify({ highway: "cycleway", foot: "designated", segregated: "no" }),
    ).toMatchObject({ comfort: 3, shared_with_pedestrians: true });
    expect(classify({ highway: "cycleway", oneway: "yes" })).toMatchObject({
      oneway: 1,
    });
  });

  it("takes designated paths and pedestrian streets as tracks", () => {
    expect(classify({ highway: "path", bicycle: "designated" })).toMatchObject({
      class: "track",
      subclass: "path",
      comfort: 4,
    });
    expect(
      classify({ highway: "pedestrian", bicycle: "designated" }),
    ).toMatchObject({ comfort: 3, shared_with_pedestrians: true });
    expect(
      classify({
        highway: "pedestrian",
        bicycle: "designated",
        segregated: "yes",
      }),
    ).toMatchObject({ comfort: 4, shared_with_pedestrians: false });
    expect(classify({ highway: "path", bicycle: "yes" })).toBeUndefined();
  });

  it("takes ferries that don't refuse bicycles as ferries, with no comfort", () => {
    expect(classify({ route: "ferry", bicycle: "yes" })).toEqual({
      class: "ferry",
      oneway: 0,
    });
    expect(classify({ route: "ferry" })).toEqual({ class: "ferry", oneway: 0 });
    expect(classify({ route: "ferry", bicycle: "no" })).toBeUndefined();
  });

  it("takes footways designated for bicycles as paths shared with pedestrians", () => {
    expect(
      classify({
        highway: "footway",
        footway: "sidewalk",
        bicycle: "designated",
      }),
    ).toEqual({
      class: "track",
      subclass: "path",
      comfort: 3,
      oneway: 0,
      shared_with_pedestrians: true,
      shared_with_vehicles: false,
    });
    expect(
      classify({
        highway: "footway",
        bicycle: "designated",
        segregated: "yes",
      }),
    ).toMatchObject({ comfort: 4, shared_with_pedestrians: false });
    expect(classify({ highway: "footway", bicycle: "yes" })).toBeUndefined();
    expect(
      classify({ highway: "bridleway", bicycle: "designated" }),
    ).toMatchObject({
      class: "track",
      subclass: "path",
      comfort: 3,
      shared_with_pedestrians: false,
    });
  });

  it("takes tracks closed to motor vehicles as paths, and designated ones open to them as shared", () => {
    expect(
      classify({ highway: "track", bicycle: "yes", motor_vehicle: "no" }),
    ).toEqual({
      class: "track",
      subclass: "track",
      comfort: 4,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
    });
    expect(
      classify({
        highway: "track",
        bicycle: "designated",
        motor_vehicle: "no",
        foot: "designated",
      }),
    ).toMatchObject({ comfort: 4, shared_with_pedestrians: true });
    expect(classify({ highway: "track", bicycle: "designated" })).toEqual({
      class: "lane",
      comfort: 3,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
    });
    expect(classify({ highway: "track", bicycle: "yes" })).toBeUndefined();
    expect(
      classify({ highway: "track", bicycle: "no", motor_vehicle: "no" }),
    ).toBeUndefined();
    expect(
      classify({ highway: "track", railway: "abandoned" }),
    ).toBeUndefined();
  });

  it("names a track tagged on its road after the road", () => {
    expect(classify({ highway: "secondary", cycleway: "track" })).toMatchObject(
      { class: "track", subclass: "combined-secondary" },
    );
  });

  it("keeps what a cycleway under construction says about its opening", () => {
    expect(
      classify({
        highway: "construction",
        construction: "cycleway",
        opening_date: "2027",
        website: "https://example.org",
      }),
    ).toEqual({
      class: "track",
      subclass: "cycleway",
      comfort: 4,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: false,
      construction: true,
      website: "https://example.org",
      opening_date: "2027",
    });
  });

  it("rates painted lanes on both sides low, and least beside parked cars", () => {
    for (const tags of [
      { cycleway: "lane" },
      { "cycleway:both": "lane" },
      { "cycleway:left": "lane", "cycleway:right": "lane" },
    ])
      expect(classify({ highway: "secondary", ...tags })).toEqual({
        class: "lane",
        side: "both",
        comfort: 2,
        oneway: 0,
        shared_with_pedestrians: false,
        shared_with_vehicles: false,
      });
    for (const parking of [
      { parking: "street_side" },
      { "parking:both": "lane" },
      { "parking:both": "separate" },
      { "parking:left": "separate" },
    ])
      expect(
        classify({ highway: "secondary", cycleway: "lane", ...parking }),
      ).toMatchObject({ comfort: 1, dooring_risk: true });
  });

  it("finds a two-way lane on one side of a two-way road", () => {
    expect(
      classify({
        highway: "residential",
        "cycleway:left": "lane",
        "cycleway:left:oneway": "no",
      }),
    ).toMatchObject({ class: "lane", side: "left", oneway: 0, comfort: 2 });
  });

  it("makes a lane on a one-way road one-way, unless there's one each side", () => {
    expect(
      classify({ highway: "secondary", oneway: "yes", cycleway: "lane" }),
    ).toMatchObject({ side: "right", oneway: 1, comfort: 2 });
    expect(
      classify({
        highway: "secondary",
        oneway: "yes",
        "cycleway:left": "lane",
        "cycleway:right": "lane",
      }),
    ).toMatchObject({ side: "left", oneway: 0 });
    expect(
      classify({
        highway: "secondary",
        oneway: "yes",
        "cycleway:left": "lane",
        "parking:left": "lane",
      }),
    ).toMatchObject({ comfort: 1, dooring_risk: true });
  });

  it("rates shared lanes by traffic", () => {
    expect(classify({ highway: "primary", cycleway: "shared_lane" })).toEqual({
      class: "lane",
      comfort: 1,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
    });
    expect(
      classify({ highway: "primary", cycleway: "shared", maxspeed: "30" }),
    ).toMatchObject({ comfort: 3 });
    expect(
      classify({
        highway: "primary",
        cycleway: "shared",
        maxspeed: "CA:urban",
      }),
    ).toMatchObject({ comfort: 1 });
    expect(
      classify({
        highway: "service",
        cycleway: "shared_lane",
        motor_vehicle: "private",
      }),
    ).toMatchObject({ comfort: 3 });
    expect(
      classify({
        highway: "primary",
        cycleway: "shared_lane",
        oneway: "yes",
        "oneway:bicycle": "no",
      }),
    ).toMatchObject({ oneway: 0 });
    // As the Planetiler profile had it: no highway tag needed with cycleway:both.
    expect(classify({ "cycleway:both": "shared_lane" })).toMatchObject({
      shared_with_vehicles: true,
    });
  });

  it("takes slow residential streets open to bicycles as local bikeways", () => {
    expect(
      classify({
        highway: "residential",
        bicycle: "designated",
        maxspeed: "30",
        foot: "yes",
        oneway: "yes",
      }),
    ).toEqual({
      class: "lane",
      comfort: 3,
      oneway: 1,
      shared_with_pedestrians: true,
      shared_with_vehicles: true,
    });
    expect(
      classify({ highway: "residential", bicycle: "yes", maxspeed: "50" }),
    ).toBeUndefined();
    expect(
      classify({ highway: "residential", bicycle: "yes" }),
    ).toBeUndefined();
  });

  it("finds a one-way lane on one side of a two-way road", () => {
    expect(
      classify({
        highway: "tertiary",
        "cycleway:left": "lane",
        "cycleway:right": "no",
      }),
    ).toMatchObject({ side: "left", oneway: -1, comfort: 2 });
    expect(
      classify({
        highway: "tertiary",
        "cycleway:right": "lane",
        "cycleway:left": "no",
        "parking:right": "lane",
      }),
    ).toMatchObject({ side: "right", oneway: 1, dooring_risk: true });
  });

  it("rates a lane one way and a shared lane the other by the less comfortable", () => {
    // Stevens Drive, West Vancouver (way 59432713).
    expect(
      classify({
        highway: "tertiary",
        oneway: "no",
        maxspeed: "50",
        "cycleway:left": "shared_lane",
        "cycleway:right": "lane",
      }),
    ).toEqual({
      class: "lane",
      side: "right",
      comfort: 1,
      oneway: 0,
      shared_with_pedestrians: false,
      shared_with_vehicles: true,
      varies_by_direction: true,
    });
    expect(
      classify({
        highway: "residential",
        maxspeed: "30",
        "cycleway:left": "lane",
        "cycleway:right": "shared",
      }),
    ).toMatchObject({ side: "left", comfort: 2, varies_by_direction: true });
    expect(
      classify({
        highway: "residential",
        maxspeed: "30",
        "cycleway:left": "lane",
        "cycleway:right": "shared_lane",
        "parking:left": "lane",
      }),
    ).toMatchObject({ comfort: 1, dooring_risk: true });
  });

  it("ignores roads without a cycling facility", () => {
    expect(classify({ highway: "residential" })).toBeUndefined();
    expect(
      classify({ highway: "secondary", "cycleway:right": "lane" }),
    ).toBeUndefined();
  });
});

describe("maxspeedKmh", () => {
  it("reads numbers, units, walking pace and the fastest of several", () => {
    expect(maxspeedKmh("30")).toBe(30);
    expect(maxspeedKmh("30 km/h")).toBe(30);
    expect(maxspeedKmh("20 mph")).toBeCloseTo(32.19, 2);
    expect(maxspeedKmh("walk")).toBe(6);
    expect(maxspeedKmh("50;30")).toBe(50);
  });

  it("doesn't read implied limits or words as slow", () => {
    for (const v of ["CA:urban", "none", "signals", "30;CA:urban", undefined])
      expect(maxspeedKmh(v)).toBeUndefined();
  });
});

describe("isBikeRoute", () => {
  it("takes route relations for bicycles", () => {
    expect(isBikeRoute({ type: "route", route: "bicycle" })).toBe(true);
    expect(isBikeRoute({ type: "superroute", route: "bicycle" })).toBe(true);
    expect(isBikeRoute({ type: "route", route: "bus" })).toBe(false);
  });
});
