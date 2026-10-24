import { describe, expect, it } from "vitest";
import {
  STOP_NO_DROPOFF,
  STOP_NO_PICKUP,
  type PlanPattern,
  type PlanRoute,
  type PlanTrip,
  type ServicePlan,
} from "../src/plan/types.ts";
import { routeGroups } from "../src/plan/route-groups.ts";
import { routeStops, routeWeekdaySpeeds } from "../src/schedule/stops.ts";
import { serviceDate } from "../src/time.ts";
import { spacingTier } from "@transitopia/shared/stop-spacing.ts";

const H = 3600;

const route = (key: string, mode: PlanRoute["mode"] = "bus"): PlanRoute => ({
  key,
  label: key,
  kind: mode === "bus" ? "bus" : "shape",
  mode,
  brand: mode !== "bus",
  color: "#666666",
  textColor: "#ffffff",
  gtfsRouteId: key,
});

const pattern = (
  id: number,
  dist: number[],
  access?: number[],
): PlanPattern => ({
  id,
  route: "25",
  direction: 0,
  shape: "s",
  stops: dist.map((_, i) => i),
  dist,
  ...(access ? { access } : {}),
});

const trip = (
  pattern: number,
  start: number,
  arr: number[],
  headsign = "25 King Edward To Brentwood Station",
): PlanTrip => ({
  id: `${pattern}-${start}`,
  pattern,
  service: "wk",
  headsign,
  start,
  arr,
});

const plan = (patterns: PlanPattern[], trips: PlanTrip[]) =>
  ({
    routes: [route("25")],
    patterns,
    trips,
    calendar: {
      calendar: [
        {
          serviceId: "wk",
          days: [true, true, true, true, true, false, false],
          start: serviceDate("20261001"),
          end: serviceDate("20261031"),
        },
      ],
      exceptions: [],
    },
    feedStart: serviceDate("20261001"),
    feedEnd: serviceDate("20261031"),
  }) as Pick<
    ServicePlan,
    "routes" | "patterns" | "trips" | "calendar" | "feedStart" | "feedEnd"
  >;

describe("routeStops", () => {
  it("averages spacing over every trip, as TransLink measures it, with the busiest pattern's stops", () => {
    // Five stops over 1,200 m (300 m apart), three trips; a short turn of three stops over 400 m
    // (200 m apart), one trip: (3 × 1200 + 400) / (3 × 4 + 2) ≈ 286 m.
    const long = pattern(0, [0, 300, 600, 900, 1200]);
    const short = pattern(1, [0, 200, 400]);
    const trips = [
      trip(0, 6 * H, [0, 60, 120, 180, 240]),
      trip(0, 7 * H, [0, 60, 120, 180, 240]),
      trip(0, 8 * H, [0, 60, 120, 180, 240], "25 To UBC"),
      trip(1, 9 * H, [0, 60, 120]),
    ];
    expect(routeStops(plan([long, short], trips)).get("25")).toEqual({
      spacing: 286,
      count: 5,
      length: 1200,
      headsign: "25 King Edward To Brentwood Station",
    });
  });

  it("counts only stops passengers can use", () => {
    // A timing point at 500 m with no boarding or alighting, and a layover past the last stop.
    const both = STOP_NO_PICKUP | STOP_NO_DROPOFF;
    const p = pattern(0, [0, 500, 1000, 1300], [0, both, 0, both]);
    const stops = routeStops(plan([p], [trip(0, 6 * H, [0, 60, 120, 180])]));
    expect(stops.get("25")).toMatchObject({
      spacing: 1000,
      count: 2,
      length: 1000,
    });
  });
});

describe("routeWeekdaySpeeds", () => {
  it("gives the slowest and fastest hour from 06:00 to 21:00, leaving out late night", () => {
    const p = pattern(0, [0, 5000, 10000]);
    const trips = [
      // 10 km in 40 min at 08:00 (15 km/h), in 30 min at 12:00 (20 km/h).
      trip(0, 8 * H, [0, 1200, 2400]),
      trip(0, 12 * H, [0, 900, 1800]),
      // 10 km in 15 min at 23:00 (40 km/h): outside the window.
      trip(0, 23 * H, [0, 450, 900]),
    ];
    expect(routeWeekdaySpeeds(plan([p], trips)).get("25")).toEqual([15, 20]);
  });
});

describe("routeGroups", () => {
  const withStops = (spacing: number): PlanRoute => ({
    ...route("25"),
    stops: { spacing, count: 10, length: spacing * 9, headsign: "" },
  });

  it("puts rail and ferries in rapid transit", () => {
    expect(routeGroups(route("expo", "skytrain"), 3)).toEqual(["rapid"]);
  });

  it("puts a bus in Frequent by its weekday figure and in Fast by its stop spacing", () => {
    // Up to 12 min is OK, a frequent band; 600 m is Limited stops.
    expect(routeGroups(withStops(400), 12)).toEqual(["frequent"]);
    expect(routeGroups(withStops(1000), 7)).toEqual(["frequent", "fast"]);
    expect(routeGroups(withStops(600), 30)).toEqual(["fast"]);
    expect(routeGroups(withStops(400), 13)).toEqual(["regular"]);
    expect(routeGroups(withStops(400), undefined)).toEqual(["regular"]);
  });
});

describe("spacingTier", () => {
  it("names the tiers from their lower bounds", () => {
    expect(
      [240, 250, 599, 600, 1499, 1500].map((m) => spacingTier(m).name),
    ).toEqual([
      "Every block",
      "Local",
      "Local",
      "Limited stops",
      "Limited stops",
      "Express",
    ]);
  });
});
