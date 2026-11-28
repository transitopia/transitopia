import { describe, expect, it } from "vitest";
import type { PlanRoute } from "@transitopia/transit-core/plan/types.ts";
import { EFFECT_REDUCED_SERVICE } from "@transitopia/transit-core/rt/changes.ts";
import { serviceAlert, tidyText } from "../src/alerts.ts";

describe("serviceAlert", () => {
  it("tidies TransLink's mixed line breaks", () => {
    expect(
      tidyText("\n\r\nExpected to reopen.  \r\n\nUse King Edward.\r\n"),
    ).toBe("Expected to reopen.\n\nUse King Edward.");
  });

  it("is about the plan's routes it names, in the plan's order", () => {
    const route = (key: string) => ({ feed: "translink", key }) as PlanRoute;
    const routes = new Map(
      ["expo", "millennium", "canada"].map((k) => [k, route(k)]),
    );
    const a = serviceAlert(
      {
        id: "1",
        entities: [{ routeKey: "canada" }, { routeKey: "expo" }],
        stopIds: [],
        effect: EFFECT_REDUCED_SERVICE,
        periods: [{ start: 10, end: 20 }],
        header: " Track work ",
        description: "",
        seen: [0, 30],
      },
      "translink",
      routes,
      "America/Vancouver",
      15,
    );
    expect(a.routes.map((r) => r.key)).toEqual(["expo", "canada"]);
    expect(a).toMatchObject({
      id: "translink:1",
      header: "Track work",
      service: true,
      start: 10,
      end: 20,
    });
  });
});
