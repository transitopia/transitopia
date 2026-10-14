import { describe, expect, it } from "vitest";
import {
  bayAtPlace,
  bayLabel,
  bayNumber,
  busHubs,
  isBay,
} from "../src/plan/exchanges.ts";
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

  it("adds bays only catalogue routes use, but no exchange of their own", () => {
    const withCatalog = {
      ...plan,
      stops: [
        ...plan.stops,
        stop("u3", "UBC Exchange @ Bay 3", -123.2474, 49.2677),
        stop("s5", "Scott Road Station @ Bay 5", -122.8901, 49.2046),
        stop("n1", "Newton Exchange @ Bay 1", -122.8418, 49.1328),
      ],
      catalog: [
        { key: "25", stops: ["u3", "n1"] },
        { key: "319", stops: ["s5"] },
      ],
    } as unknown as ServicePlan;
    const hubs = busHubs(withCatalog);
    expect(hubs.find((h) => h.id === "ubc-exchange")!.bays).toEqual([
      "u3",
      "u7",
      "u10",
      "uu",
    ]);
    // Routes are the drawn ones; cards add catalogue routes per bay.
    expect(hubs.find((h) => h.id === "ubc-exchange")!.routes).toEqual(["99"]);
    expect(hubs.find((h) => h.station === "99949")!.bays).toEqual([
      "s2",
      "s3",
      "s5",
    ]);
    // Newton has no drawn bus: not an exchange (yet).
    expect(hubs).toHaveLength(2);
  });
});

describe("bayLabel", () => {
  it("names bays shortly", () => {
    expect(bayLabel("Joyce Station @ Bay 1 Unload Only")).toBe("Bay 1");
    expect(bayLabel("UBC Exchange @ Unloading Only")).toBe("Unloading Only");
    expect(bayLabel("Phibbs Exchange @")).toBe("Bay");
  });
});

describe("bayAtPlace", () => {
  const hubBays = [
    { id: "u7", name: "UBC Exchange @ Bay 7", lon: -123.2475, lat: 49.2676 },
  ];
  const stations = [
    {
      id: "99949",
      name: "Scott Road",
      lon: -122.8897,
      lat: 49.2043,
      routes: [],
    },
  ];
  const at = (name: string, lon: number, lat: number) =>
    bayAtPlace({ name, lon, lat }, hubBays, stations);

  it("keeps bays at an exchange or beside a station on the map", () => {
    expect(at("UBC Exchange @ Bay 3", -123.2474, 49.2677)).toBe(true);
    expect(at("Scott Rd Station @ Bay 5", -122.8901, 49.2046)).toBe(true);
  });

  it("leaves other bays and street stops out", () => {
    expect(at("Newton Exchange @ Bay 1", -122.8418, 49.1328)).toBe(false);
    expect(at("Eastbound W Broadway @ Alma St", -123.2474, 49.2677)).toBe(
      false,
    );
    // Same name, but a different place far away.
    expect(at("UBC Exchange @ Bay 3", -123.1, 49.2)).toBe(false);
  });
});
