import { describe, expect, it } from "vitest";
import type { PlacesFile } from "@transitopia/shared/features.ts";
import {
  resolveSelect,
  selectKey,
  vehicleKey,
  vehicleOfKey,
  type SelectContext,
} from "../src/select.ts";

const plan: SelectContext["plan"] = {
  stations: [{ id: "12034", name: "Waterfront", lon: 0, lat: 0, routes: [] }],
  stops: [
    {
      id: "13001",
      name: "UBC Exchange @ Bay 1",
      lon: 0,
      lat: 0,
      code: "60001",
    },
    { id: "11001", name: "Platform 1", lon: 0, lat: 0 },
  ],
  routes: [
    {
      key: "99",
      label: "99",
      kind: "bus",
      mode: "bus",
      color: "#000",
      textColor: "#fff",
      gtfsRouteId: "6612",
    },
  ],
};
const hubs: SelectContext["hubs"] = [
  {
    id: "ubc-exchange",
    name: "UBC Exchange",
    lon: 0,
    lat: 0,
    bays: ["13001"],
    routes: [],
  },
];
const places: PlacesFile = {
  format: 1,
  feed: "translink",
  version: "V1",
  n: 1,
  stations: { "12034": "sn-00000001-waterfront" },
  stops: { "13001": "st-00000004-60001" },
  routes: { "99": "rt-00000006-99" },
  parents: { "13001": "ex-00000002" },
  places: {
    "ex-00000002": {
      kind: "exchange",
      key: "ex-00000002-ubc-exchange",
      name: "UBC Exchange",
      lon: 0,
      lat: 0,
    },
  },
  redirects: { "st-00000009": "st-00000004" },
};
const ctx: SelectContext = { feed: "translink", plan, hubs, places };
const bare: SelectContext = { ...ctx, places: null };

describe("?select=", () => {
  it("finds IDs in the places file, whatever their suffix", () => {
    expect(resolveSelect("sn-00000001", ctx)).toEqual({
      place: { kind: "station", id: "12034" },
    });
    expect(resolveSelect("st-00000004-wrong-name", ctx)).toEqual({
      place: { kind: "stop", id: "13001" },
    });
    expect(resolveSelect("st-00000009", ctx)).toEqual({
      place: { kind: "stop", id: "13001" },
    });
    expect(resolveSelect("rt-00000006-99", ctx)).toEqual({
      place: { kind: "route", id: "99" },
    });
    expect(resolveSelect("ex-00000002", ctx)).toEqual({
      place: { kind: "exchange", id: "ubc-exchange" },
    });
    expect(resolveSelect("sn-0000000z", ctx)).toBe("elsewhere");
    expect(resolveSelect("sn-00000001", bare)).toBe("elsewhere");
  });

  it("finds refs in the plan", () => {
    expect(resolveSelect("stop:translink:60001", bare)).toEqual({
      place: { kind: "stop", id: "13001" },
    });
    expect(resolveSelect("gtfs-stop:translink:12034", bare)).toEqual({
      place: { kind: "station", id: "12034" },
    });
    expect(resolveSelect("gtfs-route:translink:6612", bare)).toEqual({
      place: { kind: "route", id: "99" },
    });
    expect(resolveSelect("stop:bc-transit-victoria:60001", bare)).toBe(
      "elsewhere",
    );
  });

  it("ignores the old forms", () => {
    for (const k of ["station:12034", "stop:13001", "route:99", "expo-005"])
      expect(resolveSelect(k, ctx), k).toBeUndefined();
  });

  it("writes IDs with their suffix, else refs", () => {
    expect(selectKey({ place: { kind: "station", id: "12034" } }, ctx)).toBe(
      "sn-00000001-waterfront",
    );
    expect(
      selectKey({ place: { kind: "exchange", id: "ubc-exchange" } }, ctx),
    ).toBe("ex-00000002-ubc-exchange");
    // Without its ID an exchange has no key: a bay's ref would reopen as the bay.
    expect(
      selectKey({ place: { kind: "exchange", id: "ubc-exchange" } }, bare),
    ).toBeUndefined();
    expect(selectKey({ place: { kind: "stop", id: "13001" } }, bare)).toBe(
      "stop:translink:60001",
    );
    expect(selectKey({ place: { kind: "stop", id: "11001" } }, bare)).toBe(
      "gtfs-stop:translink:11001",
    );
    expect(selectKey({ place: { kind: "route", id: "99" } }, bare)).toBe(
      "gtfs-route:translink:6612",
    );
  });

  it("names a combined route by its ends' keys", () => {
    const shared = { place: { kind: "shared" as const, id: "12034>13001" } };
    expect(selectKey(shared, ctx)).toBe(
      "shared:sn-00000001-waterfront:st-00000004-60001",
    );
    expect(
      resolveSelect("shared:sn-00000001-waterfront:st-00000004-60001", ctx),
    ).toEqual(shared);
    // Without a registry, refs: their colons don't confuse the split.
    const key = selectKey(shared, bare)!;
    expect(key).toBe("shared:gtfs-stop:translink:12034:stop:translink:60001");
    expect(resolveSelect(key, bare)).toEqual(shared);
    expect(resolveSelect("shared:sn-00000001:st-0000000z", ctx)).toBe(
      undefined,
    );
  });

  it("names vehicles by their engine id", () => {
    expect(vehicleKey("translink", "expo-005")).toBe("run:expo-005");
    expect(vehicleKey("translink", "rt:9401")).toBe("rt:translink:9401");
    expect(vehicleOfKey("rt:translink:9401", "translink")).toBe("rt:9401");
    expect(vehicleOfKey("run:expo-005", "translink")).toBe("expo-005");
    expect(
      vehicleOfKey("rt:bc-transit-victoria:1", "translink"),
    ).toBeUndefined();
  });
});
