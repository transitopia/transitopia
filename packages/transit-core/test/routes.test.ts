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
    const { routes, skipped } = selectRoutes(ROWS, cfg({ routes: [] }), "ds");
    expect(routes.map((r) => [r.key, r.label, r.kind, r.category])).toEqual([
      ["expo-line", "Expo Line", "shape", "rapid"],
      ["seabus", "SeaBus", "shape", "rapid"],
      ["25", "25 King Edward", "bus", "regular"],
      ["99", "99 Broadway B-Line", "bus", "regular"],
      ["N17", "N17 UBC/Downtown Night Bus", "bus", "regular"],
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
            category: "frequent",
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
      category: "frequent",
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
        undefined,
      ),
    ).toThrow(/matches more than one/);
    expect(() =>
      selectRoutes(
        [row("a", "005", "Robson"), row("b", "5", "Davie")],
        cfg({ routes: [] }),
        undefined,
      ),
    ).toThrow(/Two routes have the key 5/);
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
