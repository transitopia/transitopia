import { describe, expect, it } from "vitest";
import { bayLabel, bayNumber, busHubs, isBay } from "../src/plan/exchanges.ts";
import type { ServicePlan } from "../src/plan/types.ts";

describe("isBay", () => {
  it("knows exchange and station bays from street stops and layovers", () => {
    expect(isBay("UBC Exchange @ Bay 7")).toBe(true);
    expect(isBay("UBC Exchange @ Unloading Only")).toBe(true);
    expect(isBay("Joyce Station @ Bay 1 Unload Only")).toBe(true);
    expect(isBay("Phibbs Exchange @")).toBe(true);
    expect(isBay("Newton Exchange @ Layover")).toBe(false);
    expect(isBay("Eastbound W Broadway @ Alma St")).toBe(false);
    expect(isBay("Westbound W Broadway @ Bayswater St")).toBe(false);
  });

  it("reads bay numbers", () => {
    expect(bayNumber("Metrotown Station @ Bay 14")).toBe("14");
    expect(bayNumber("UBC Exchange @ Unloading Only")).toBeUndefined();
  });
});

describe("busHubs", () => {
  const stop = (id: string, name: string, lon: number, lat: number) => ({
    id,
    name,
    lon,
    lat,
  });
  const plan = {
    routes: [
      { key: "99", kind: "bus" },
      { key: "R6", kind: "bus" },
      { key: "expo", kind: "skytrain" },
    ],
    stops: [
      stop("u7", "UBC Exchange @ Bay 7", -123.2475, 49.2676),
      stop("u10", "UBC Exchange @ Bay 10", -123.2472, 49.2679),
      stop("uu", "UBC Exchange @ Unloading Only", -123.2478, 49.2674),
      stop("s2", "Scott Rd Station @ Bay 2", -122.8903, 49.2044),
      stop("s3", "Scott Road Station @ Bay 3", -122.8899, 49.2047),
      stop("p1", "Scott Road Station @ Platform 1", -122.8897, 49.2043),
      stop("x", "Eastbound W Broadway @ Alma St", -123.1846, 49.2643),
    ],
    stations: [
      {
        id: "99949",
        name: "Scott Road",
        lon: -122.8897,
        lat: 49.2043,
        routes: ["expo"],
      },
    ],
    patterns: [
      { id: 0, route: "99", stops: [6, 1, 0, 2] },
      { id: 1, route: "R6", stops: [3, 4] },
      { id: 2, route: "expo", stops: [5] },
    ],
    trips: [{ pattern: 0 }, { pattern: 1 }, { pattern: 2 }],
  } as unknown as ServicePlan;

  it("gathers an exchange's bays, by bay number", () => {
    const ubc = busHubs(plan).find((h) => h.id === "ubc-exchange")!;
    expect(ubc.name).toBe("UBC Exchange");
    expect(ubc.station).toBeUndefined();
    expect(ubc.bays).toEqual(["u7", "u10", "uu"]);
    expect(ubc.routes).toEqual(["99"]);
  });

  it("gives a station its bays, whatever they're called", () => {
    const scott = busHubs(plan).find((h) => h.station === "99949")!;
    expect(scott).toMatchObject({
      id: "scott-road",
      name: "Scott Road",
      bays: ["s2", "s3"],
      routes: ["R6"],
    });
    expect(busHubs(plan)).toHaveLength(2);
  });
});

describe("bayLabel", () => {
  it("names bays shortly", () => {
    expect(bayLabel("Joyce Station @ Bay 1 Unload Only")).toBe("Bay 1");
    expect(bayLabel("UBC Exchange @ Unloading Only")).toBe("Unloading Only");
    expect(bayLabel("Phibbs Exchange @")).toBe("Bay");
  });
});
