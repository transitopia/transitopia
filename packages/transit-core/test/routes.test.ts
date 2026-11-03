import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  defaultKey,
  defaultModel,
  selectRoutes,
  type GtfsRouteRow,
} from "../src/plan/routes.ts";

const row = (
  route_id: string,
  route_short_name: string,
  route_long_name: string,
  route_type = "3",
  route_color = "",
): GtfsRouteRow => ({
  route_id,
  route_short_name,
  route_long_name,
  route_type,
  route_color,
});

const ROWS = [
  row("6627", "025", "King Edward"),
  row("6641", "099", "Broadway B-Line", "3", "d04110"),
  row("30053", "", "Expo Line", "1", "0033a0"),
  row("6771", "", "SeaBus", "4", "746661"),
  row("N17", "N17", "UBC/Downtown Night Bus"),
  row("HD", "HD", "HandyDART", "715"),
  row("CC", "", "Cable car", "5"),
];

const cfg = (json: unknown) => parseConfig("routes", json);

describe("selectRoutes", () => {
  it("draws every route by default, modelled from its route_type", () => {
    const { routes, skipped } = selectRoutes(
      ROWS,
      cfg({ routes: [] }),
      "translink",
      "ds",
    );
    expect(routes.map((r) => [r.key, r.label, r.kind, r.brand])).toEqual([
      ["expo-line", "Expo Line", "shape", true],
      ["seabus", "SeaBus", "shape", true],
      ["25", "25 King Edward", "bus", false],
      ["99", "99 Broadway B-Line", "bus", false],
      ["N17", "N17 UBC/Downtown Night Bus", "bus", false],
    ]);
    expect(routes.find((r) => r.key === "25")).toMatchObject({
      color: "#666666",
      gtfsRouteId: "6627",
      dataset: "ds",
    });
    expect(routes.find((r) => r.key === "99")!.color).toBe("#d04110");
    // Demand-responsive service and modes without a default are left out, saying why.
    expect(skipped.map((s) => s.row.route_id)).toEqual(["HD", "CC"]);
  });

  it("applies overrides by name and excludes routes", () => {
    const { routes, skipped, unmatched } = selectRoutes(
      ROWS,
      cfg({
        routes: [
          {
            key: "expo",
            match: { route_long_name: "Expo Line" },
            kind: "skytrain",
            mode: "skytrain",
          },
          {
            key: "99",
            label: "99 B-Line",
            match: { route_short_name: "099" },
            brand: true,
            color: "#f76707",
          },
          {
            key: "cable",
            match: { route_long_name: "Cable car" },
            kind: "shape",
            mode: "rail",
          },
          { key: "gone", match: { route_short_name: "123" } },
        ],
        exclude: [{ match: { route_short_name: "N17" } }],
      }),
      "translink",
      undefined,
    );
    expect(routes.map((r) => r.key)).toEqual([
      "expo",
      "cable",
      "seabus",
      "99",
      "25",
    ]);
    expect(routes[0]).toMatchObject({ kind: "skytrain", mode: "skytrain" });
    expect(routes.find((r) => r.key === "99")).toMatchObject({
      label: "99 B-Line",
      brand: true,
      color: "#f76707",
    });
    expect(routes.some((r) => "dataset" in r)).toBe(false);
    expect(skipped.map((s) => s.row.route_id)).toEqual(["N17", "HD"]);
    // An entry for a route the feed no longer has isn't an error.
    expect(unmatched.map((u) => u.key)).toEqual(["gone"]);
  });

  it("refuses an entry matching two routes, and two routes with one key", () => {
    expect(() =>
      selectRoutes(
        [row("a", "5", "Robson"), row("b", "5", "Robson")],
        cfg({ routes: [{ key: "5", match: { route_short_name: "5" } }] }),
        "translink",
        undefined,
      ),
    ).toThrow(/matches more than one/);
    expect(() =>
      selectRoutes(
        [row("a", "005", "Robson"), row("b", "5", "Davie")],
        cfg({ routes: [] }),
        "translink",
        undefined,
      ),
    ).toThrow(/Two routes have the key 5/);
  });
});

describe("keyed by route_id", () => {
  it("keys a feed's routes by route_id, named by their short name", () => {
    const { routes } = selectRoutes(
      [
        row("1-COM", "1", "Comox Mall / Anfield Centre"),
        row("1-CAM", "1", "Campbellton / Willow Point"),
        row("2-COM", "002", "Cumberland"),
      ],
      cfg({ routes: [] }),
      "bc-transit-north-island",
      undefined,
      "route_id",
    );
    expect(routes.map((r) => [r.key, r.shortName, r.label])).toEqual([
      ["1-CAM", "1", "1 Campbellton / Willow Point"],
      ["1-COM", "1", "1 Comox Mall / Anfield Centre"],
      ["2-COM", "2", "2 Cumberland"],
    ]);
  });

  it("names routes keyed by name by their key alone", () => {
    const { routes } = selectRoutes(
      [row("6627", "025", "King Edward")],
      cfg({ routes: [] }),
      "translink",
      undefined,
    );
    expect(routes[0]!.key).toBe("25");
    expect("shortName" in routes[0]!).toBe(false);
  });
});

describe("merged routes", () => {
  it("draws one route for every GTFS route an entry's match list matches", () => {
    const { routes } = selectRoutes(
      [
        row("NAN-VAN", "Nan→Van", "Nanaimo to Vancouver", "4"),
        row("VAN-NAN", "Van→Nan", "Vancouver to Nanaimo", "4"),
      ],
      cfg({
        routes: [
          {
            key: "hullo",
            label: "Hullo",
            match: [
              { route_long_name: "Nanaimo to Vancouver" },
              { route_long_name: "Vancouver to Nanaimo" },
            ],
          },
        ],
      }),
      "hullo",
      undefined,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      key: "hullo",
      label: "Hullo",
      mode: "ferry",
      gtfsRouteId: "NAN-VAN",
      mergedGtfsRouteIds: ["VAN-NAN"],
    });
  });
});

describe("defaults", () => {
  it("keys routes by short name, else long name", () => {
    expect(defaultKey(row("x", "R1", "King George Blvd"))).toBe("R1");
    expect(defaultKey(row("x", "002", ""))).toBe("2");
    expect(defaultKey(row("x", "0", ""))).toBe("0");
    expect(defaultKey(row("x", " ", "Millennium Line"))).toBe(
      "millennium-line",
    );
    expect(defaultKey(row("x", "", ""))).toBeUndefined();
  });

  it("models basic and extended route types", () => {
    expect(defaultModel("3")?.kind).toBe("bus");
    expect(defaultModel("700")?.kind).toBe("bus");
    expect(defaultModel("715")).toBeUndefined();
    expect(defaultModel("2")?.mode).toBe("rail");
    expect(defaultModel("1200")?.mode).toBe("ferry");
    expect(defaultModel(undefined)).toBeUndefined();
  });
});
