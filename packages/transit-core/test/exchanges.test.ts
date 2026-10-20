import { describe, expect, it } from "vitest";
import {
  baseName,
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
    // Streets named Bay (seen across TransLink's whole feed, 2026-10).
    expect(isBay("Southbound Nelson Ave @ Bay St")).toBe(false);
    expect(isBay("Eastbound Fraser Way @ Bay Mill Rd")).toBe(false);
    expect(isBay("Surrey Central Station @ Bay 5A")).toBe(true);
    expect(isBay("King Edward Station @ Bay 3 -")).toBe(true);
    expect(isBay("Bridgeport Station @ Unloading Bay")).toBe(true);
  });

  it("reads BC Transit's bays, which have no @", () => {
    expect(isBay("Langford Exch (Jacklin Rd) Bay D")).toBe(true);
    expect(isBay("UBCO Exchange Bay C")).toBe(true);
    expect(isBay("Legislature Exch")).toBe(true);
    expect(isBay("Swartz Bay Ferry Terminal Bay A")).toBe(true);
    expect(isBay("Douglas St at Bay St")).toBe(false);
    expect(isBay("Cooper Rd at Orchard Park Exchange")).toBe(false);
    expect(isBay("Fort St at Foul Bay Rd")).toBe(false);
    expect(isBay("HMC Dockyard Terminal")).toBe(false);
    expect(bayNumber("Royal Oak Exch Bay H")).toBe("H");
    expect(bayLabel("Langford Exch (Jacklin Rd) Bay D")).toBe("Bay D");
    expect(bayLabel("Legislature Exch")).toBe("Bay");
    expect(baseName("Langford Exch (Jacklin Rd) Bay D")).toBe(
      "Langford Exchange",
    );
    expect(baseName("Langford Exch Bay A")).toBe("Langford Exchange");
    expect(baseName("Legislature Exch")).toBe("Legislature Exchange");
    expect(baseName("Southbound White Rock Centre @ Bay 11")).toBe(
      "White Rock Centre",
    );
    expect(baseName("UBCO Exchange Bay C")).toBe("UBCO Exchange");
    expect(baseName("Swartz Bay Ferry Terminal Bay A")).toBe(
      "Swartz Bay Ferry Terminal",
    );
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
