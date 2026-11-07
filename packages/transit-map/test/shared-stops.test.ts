import { describe, expect, it } from "vitest";
import type { PlacesFile } from "@transitopia/shared/features.ts";
import { sharedStopOwners } from "../src/plans.ts";

const places = (
  feed: string,
  stops: Record<string, string>,
  homes?: Record<string, string>,
): { feed: string; places: PlacesFile } => ({
  feed,
  places: {
    format: 1,
    feed,
    version: "v",
    n: 1,
    stations: {},
    stops,
    routes: {},
    parents: {},
    ...(homes ? { homes } : {}),
    places: {},
    redirects: {},
  },
});

describe("sharedStopOwners (docs/DESIGN.md#shared-stops)", () => {
  // Innovation Dr at University Way: one feature in Kelowna's and Okanagan-Shuswap's feeds, Kelowna
  // its home.
  const kelowna = places("bc-transit-kelowna", {
    "140159": "st-467w2ke7-140159",
    "140001": "st-aaaaaaaa-140001",
  });
  const okanagan = places(
    "bc-transit-okanagan-shuswap",
    { "140159": "st-467w2ke7-140159", "150000": "st-bbbbbbbb-150000" },
    { "140159": "bc-transit-kelowna" },
  );

  it("draws a shared stop in its home feed only, whichever loaded first", () => {
    const expected = new Map([
      ["bc-transit-kelowna", new Map()],
      [
        "bc-transit-okanagan-shuswap",
        new Map([["140159", { feed: "bc-transit-kelowna", stop: "140159" }]]),
      ],
    ]);
    expect(sharedStopOwners([kelowna, okanagan])).toEqual(expected);
    expect(sharedStopOwners([okanagan, kelowna])).toEqual(expected);
  });

  it("draws it in the feed loaded first while its home isn't loaded", () => {
    const island = places(
      "bc-transit-vancouver-island",
      { "140159x": "st-467w2ke7-140159" },
      { "140159x": "bc-transit-kelowna" },
    );
    expect(
      sharedStopOwners([okanagan, island]).get("bc-transit-vancouver-island"),
    ).toEqual(
      new Map([
        ["140159x", { feed: "bc-transit-okanagan-shuswap", stop: "140159" }],
      ]),
    );
    expect(sharedStopOwners([okanagan]).get(okanagan.feed)).toEqual(new Map());
  });
});
