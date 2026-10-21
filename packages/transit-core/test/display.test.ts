import { describe, expect, it } from "vitest";
import translink from "@transitopia/config/feeds/translink/feed.json" with { type: "json" };
import victoria from "@transitopia/config/feeds/bc-transit-victoria/feed.json" with { type: "json" };
import { parseFeed } from "../src/config.ts";
import {
  firstBoarding,
  placeName,
  shortId,
  timetableLabel,
} from "../src/plan/display.ts";
import type { ServicePlan } from "../src/plan/types.ts";

describe("ids as riders see them", () => {
  const bct = parseFeed(victoria).display!;

  it("shortens BC Transit's trip ids and versions with its feed's patterns", () => {
    expect(shortId(bct.tripId, "11898518:14545024:14591755")).toBe("11898518");
    expect(
      shortId(bct.feedVersion, "202610140/20261013 21:00:00/20261014 04:00:00"),
    ).toBe("202610140");
  });

  it("keeps an id whole without a pattern, or when the pattern doesn't match", () => {
    expect(parseFeed(translink).display).toBeUndefined();
    expect(shortId(undefined, "15519786")).toBe("15519786");
    expect(shortId(bct.tripId, "15519786")).toBe("15519786");
  });

  it("names the timetable by agency and short version", () => {
    expect(
      timetableLabel({
        agency: "TransLink",
        feedLabel: "26SEP_20260925",
        feedVersion: "26SEP_20260925",
      }),
    ).toBe("TransLink timetable (26SEP_20260925)");
    // Plans built before they recorded their agency.
    expect(timetableLabel({ feedVersion: "26SEP_20260925" })).toBe(
      "timetable 26SEP_20260925",
    );
  });

  it("names where a trip starts: the station, the exchange, or the stop", () => {
    const plan: Pick<ServicePlan, "stops" | "stations"> = {
      stops: [
        {
          id: "1",
          name: "Waterfront Station @ Platform 2",
          lon: 0,
          lat: 0,
          parent: "99901",
        },
        { id: "2", name: "Langford Exch (Jacklin Rd) Bay D", lon: 0, lat: 0 },
        { id: "3", name: "Douglas St at Bay St", lon: 0, lat: 0 },
        {
          id: "4",
          name: "Westbound Lougheed Hwy @ Boundary Loop",
          lon: 0,
          lat: 0,
        },
      ],
      stations: [
        { id: "99901", name: "Waterfront", lon: 0, lat: 0, routes: [] },
      ],
    };
    expect([0, 1, 2, 3].map((i) => placeName(plan, i))).toEqual([
      "Waterfront",
      "Langford Exchange",
      "Bay St",
      "Boundary Loop",
    ]);
  });

  it("starts a trip where riders can first board", () => {
    const pattern = {
      id: 0,
      route: "R1",
      direction: 0,
      shape: "s",
      stops: [0, 1, 2],
      dist: [0, 100, 200],
    };
    expect(firstBoarding(pattern)).toBe(0);
    // A layover (no pickup, no drop-off) first.
    expect(firstBoarding({ ...pattern, access: [3, 0, 0] })).toBe(1);
  });

  it("refuses a display pattern that isn't a regex with a group", () => {
    for (const tripId of ["^[^:]+", "(unclosed"])
      expect(() => parseFeed({ ...victoria, display: { tripId } })).toThrow(
        /display\.tripId/,
      );
  });
});
