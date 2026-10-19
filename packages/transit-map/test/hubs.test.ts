import { describe, expect, it } from "vitest";
import type { PlacesFile } from "@transitopia/shared/features.ts";
import { hubsFromPlaces } from "../src/hubs.ts";

const stop = (id: string, name: string, more = {}) => ({
  id,
  name,
  lon: -123,
  lat: 49,
  ...more,
});

const plan = {
  routes: [
    {
      key: "99",
      label: "99",
      kind: "bus" as const,
      mode: "bus" as const,
      color: "#000",
      textColor: "#fff",
      gtfsRouteId: "6612",
    },
  ],
  stations: [
    { id: "99939", name: "Joyce-Collingwood", lon: -123, lat: 49, routes: [] },
  ],
  stops: [
    stop("11001", "Joyce-Collingwood Station @ Platform 1", {
      parent: "99939",
    }),
    stop("12002", "Joyce Station @ Bay 2"),
    stop("12001", "Joyce Station @ Bay 1"),
    stop("13002", "Blanca Loop @ Bay 2"),
    stop("13001", "Blanca Loop @ Bay 1"),
    stop("14001", "UBC Exchange @ Bay 10"),
    stop("14002", "UBC Exchange @ Bay 9"),
  ],
  patterns: [
    {
      id: 0,
      route: "99",
      direction: 0,
      shape: "s",
      stops: [1, 2, 5, 6],
      dist: [0, 1, 2, 3],
    },
  ],
  trips: [
    {
      id: "t",
      pattern: 0,
      service: "1",
      headsign: "UBC",
      start: 0,
      arr: [0, 1, 2, 3],
    },
  ],
};

const place = (kind: "station" | "exchange", key: string, name: string) => ({
  kind,
  key,
  name,
  lon: -123,
  lat: 49,
});

const places: PlacesFile = {
  format: 1,
  feed: "translink",
  version: "V1",
  n: 1,
  stations: { "99939": "sn-00000001-joyce-collingwood" },
  stops: {},
  routes: {},
  // Blanca Loop's bays were detached by an admin: in no place.
  parents: {
    "11001": "sn-00000001",
    "12001": "sn-00000001",
    "12002": "sn-00000001",
    "14001": "ex-00000002",
    "14002": "ex-00000002",
  },
  places: {
    "sn-00000001": place(
      "station",
      "sn-00000001-joyce-collingwood",
      "Joyce-Collingwood",
    ),
    "ex-00000002": place(
      "exchange",
      "ex-00000002-ubc-exchange",
      "UBC Exchange",
    ),
  },
  redirects: {},
};

describe("hubsFromPlaces", () => {
  it("groups the plan's bays as the registry does, by bay number, with feature IDs", () => {
    expect(hubsFromPlaces(plan, places)).toEqual([
      {
        id: "sn-00000001",
        name: "Joyce-Collingwood",
        lon: -123,
        lat: 49,
        bays: ["12001", "12002"],
        routes: ["99"],
        station: "99939",
      },
      {
        id: "ex-00000002",
        name: "UBC Exchange",
        lon: -123,
        lat: 49,
        bays: ["14002", "14001"],
        routes: ["99"],
      },
    ]);
  });

  it("leaves out an exchange no drawn bus serves", () => {
    const p = structuredClone(plan);
    p.patterns[0]!.stops = [1, 2];
    expect(hubsFromPlaces(p, places).map((h) => h.id)).toEqual(["sn-00000001"]);
  });
});
