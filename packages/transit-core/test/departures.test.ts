import { describe, expect, it } from "vitest";
import {
  departuresAt,
  groupDepartures,
  minutesBetween,
  placeName,
  sharedStretches,
  stopsOf,
} from "../src/schedule/departures.ts";
import {
  preparePlan,
  type ScheduleCorrections,
} from "../src/schedule/engine.ts";
import type { PlanTrip, ServicePlan } from "../src/plan/types.ts";
import type { KinematicsConfig } from "../src/movement/kinematics.ts";
import { serviceDayStart } from "../src/time.ts";
import {
  DAY_HOURS,
  dayTypes,
  hourlyMinutes,
  routeMinutes,
} from "../src/schedule/frequency.ts";

const kin: KinematicsConfig = {
  modes: {
    bus: {
      accel: 1,
      decel: 1,
      maxSpeed: 15,
      minCruiseFraction: 0,
      dwell: 0,
      length: 12,
      width: 2.6,
      profile: "linear",
    },
  },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// Two bus routes along one street: both serve S0 → S1 → S2 → S3, then A goes to S4a and B to S4b.
// A runs every 10 min from 08:00, B every 15 min; each hop takes 2 min.
const DATE = "20260926"; // a Saturday
const H8 = 8 * 3600;
const stop = (id: string, name: string, lon: number) => ({
  id,
  name,
  lon,
  lat: 49.28,
});
const trips = (
  prefix: string,
  pattern: number,
  headsign: string,
  every: number,
  n: number,
): PlanTrip[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    pattern,
    service: "sa",
    headsign,
    start: H8 + i * every * 60,
    arr: [0, 120, 240, 360, 480],
  }));
const plan: ServicePlan = {
  schema: 1,
  feedVersion: "test",
  feedStart: "20260901",
  feedEnd: "20261231",
  timezone: "America/Vancouver",
  builtAt: "",
  routes: (["A", "B"] as const).map((key) => ({
    key,
    label: key,
    kind: "bus" as const,
    mode: "bus" as const,
    color: "#000",
    textColor: "#fff",
    gtfsRouteId: key,
  })),
  stops: [
    stop("S0", "Eastbound Main St @ 1st Ave", -123.1),
    stop("S1", "Eastbound Main St @ 2nd Ave", -123.099),
    stop("S2", "Eastbound Main St @ 3rd Ave", -123.098),
    stop("S3", "Eastbound Main St @ Renfrew St", -123.097),
    stop("S4a", "Eastbound Main St @ 5th Ave", -123.096),
    stop("S4b", "Northbound Renfrew St @ 1st Ave", -123.096),
  ],
  stations: [],
  shapes: {
    a: [
      [-123.1, 49.28],
      [-123.096, 49.28],
    ],
  },
  patterns: [
    {
      id: 0,
      route: "A",
      direction: 0,
      shape: "a",
      stops: [0, 1, 2, 3, 4],
      dist: [0, 70, 140, 210, 280],
    },
    {
      id: 1,
      route: "B",
      direction: 0,
      shape: "a",
      stops: [0, 1, 2, 3, 5],
      dist: [0, 70, 140, 210, 280],
    },
  ],
  trips: [
    ...trips("a", 0, "To 5th Ave", 10, 12),
    ...trips("b", 1, "To Renfrew", 15, 8),
  ],
  calendar: {
    calendar: [
      {
        serviceId: "sa",
        days: [false, false, false, false, false, true, false],
        start: "20260901",
        end: "20261231",
      },
    ],
    exceptions: [],
  },
};
const pp = preparePlan(plan, kin);
const day = serviceDayStart(DATE);
const at = (sec: number) => day + sec * 1000;

describe("departuresAt", () => {
  it("lists every trip's departure from the stop in the window, soonest first", () => {
    const deps = departuresAt(pp, new Set(["S1"]), at(H8), at(H8 + 3600), [
      DATE,
    ]);
    // A at 08:02, 08:12, … 08:52 (6); B at 08:02, 08:17, 08:32, 08:47 (4).
    expect(deps.filter((d) => d.routeKey === "A")).toHaveLength(6);
    expect(deps.filter((d) => d.routeKey === "B")).toHaveLength(4);
    expect(deps.map((d) => d.t)).toEqual(
      deps.map((d) => d.t).sort((a, b) => a - b),
    );
    expect(deps[0]!.t).toBe(at(H8 + 120));
    expect(deps.every((d) => d.source === "schedule" && !d.cancelled)).toBe(
      true,
    );
  });

  it("doesn't count a trip ending at the stop as a departure", () => {
    expect(
      departuresAt(pp, new Set(["S4a"]), at(H8), at(H8 + 7200), [DATE]),
    ).toEqual([]);
  });

  it("finds nothing on a day without service", () => {
    expect(
      departuresAt(pp, new Set(["S1"]), at(H8), at(H8 + 3600), ["20260928"]),
    ).toEqual([]);
  });

  it("shifts trips by real-time corrections and marks cancellations", () => {
    const fix: ScheduleCorrections = {
      trips: new Map([
        [
          "a0",
          {
            anchors: [{ sched: H8, shift: 180 }],
            observed: [],
            estimate: "rt delay",
          },
        ],
      ]),
      cancelled: new Set(["b1"]),
      consists: new Map(),
    };
    const deps = departuresAt(
      pp,
      new Set(["S1"]),
      at(H8),
      at(H8 + 3600),
      [DATE],
      () => fix,
    );
    const a0 = deps.find((d) => d.tripId === "a0")!;
    expect(a0.t - a0.sched).toBe(180_000);
    expect(a0.source).toBe("predicted");
    expect(deps.find((d) => d.tripId === "b1")!.cancelled).toBe(true);
  });
});

describe("grouping, frequency and shared stretches", () => {
  const deps = departuresAt(pp, new Set(["S1"]), at(H8), at(H8 + 3600), [DATE]);
  const groups = groupDepartures(deps);

  it("groups by route and destination, soonest group first", () => {
    expect(groups.map((g) => `${g.routeKey} ${g.headsign}`)).toEqual([
      "A To 5th Ave",
      "B To Renfrew",
    ]);
  });

  it("says how often each group leaves in the next hour", () => {
    expect(minutesBetween(groups[0]!.departures, at(H8))).toBe(10);
    expect(minutesBetween(groups[1]!.departures, at(H8))).toBe(15);
    expect(
      minutesBetween(groups[1]!.departures, at(H8 + 7200)),
    ).toBeUndefined();
  });

  it("finds the stretch both routes share, up to where they split", () => {
    const shared = sharedStretches(plan, groups);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.groups).toHaveLength(2);
    expect(placeName(plan, shared[0]!.toStopId)).toBe("Renfrew St");
    expect(minutesBetween(shared[0]!.departures, at(H8))).toBe(6);
  });
});

describe("groupDepartures order", () => {
  const dep = (routeKey: string, t: number, platform?: string) => ({
    tripId: `${routeKey}${t}`,
    routeKey,
    headsign: routeKey,
    stopId: "S",
    platform,
    pattern: 0,
    index: 0,
    serviceDate: DATE,
    t,
    sched: t,
    source: "schedule" as const,
    cancelled: false,
  });
  const order = (deps: ReturnType<typeof dep>[]) =>
    groupDepartures(deps).map((g) => g.routeKey);

  it("orders by platform or bay number, then by soonest", () => {
    // Already soonest first, as departuresAt returns them.
    expect(
      order([
        dep("P3", 1, "3"),
        dep("P10", 2, "10"),
        dep("P1late", 4, "1"),
        dep("P1", 3, "1"),
        dep("P2", 5, "2"),
      ]),
    ).toEqual(["P1late", "P1", "P2", "P3", "P10"]);
  });

  it("puts groups without a platform last, by soonest", () => {
    expect(order([dep("A", 1), dep("B", 2, "5"), dep("C", 3)])).toEqual([
      "B",
      "A",
      "C",
    ]);
  });
});

describe("stopsOf", () => {
  it("includes a station's platforms", () => {
    const withStation: ServicePlan = {
      ...plan,
      stops: [
        ...plan.stops,
        {
          id: "P1",
          name: "Main Station @ Platform 1",
          lon: 0,
          lat: 0,
          parent: "ST",
          platform: "1",
        },
      ],
    };
    expect([...stopsOf(withStation, "ST")]).toEqual(["ST", "P1"]);
  });
});

describe("route frequency", () => {
  it("averages minutes between trips in an hour, per route", () => {
    expect(routeMinutes(pp, "A", DATE, H8, 3600)).toBe(10);
    expect(routeMinutes(pp, "B", DATE, H8, 3600)).toBe(15);
    expect(routeMinutes(pp, "A", DATE, H8 - 3600, 3600)).toBeUndefined();
  });

  it("fills the day strip hour by hour", () => {
    const hours = hourlyMinutes(pp, "A", DATE);
    expect(hours).toHaveLength(DAY_HOURS.length);
    expect(hours[DAY_HOURS.indexOf(8)]).toBe(10);
    expect(hours[DAY_HOURS.indexOf(10)]).toBeUndefined();
  });

  it("lists the feed's kinds of day from a date, that date's first", () => {
    // Only Saturdays have service in the fixture.
    expect(dayTypes(pp, "20260924")).toEqual([
      { date: DATE, services: ["sa"] },
    ]);
  });
});
