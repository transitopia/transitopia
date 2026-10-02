import { describe, expect, it } from "vitest";
import {
  routeStats,
  type ScheduledTrip,
  type StatsConfig,
} from "../src/rt/stats.ts";

const cfg: StatsConfig = {
  onTimeS: [-60, 180],
  maxPrecisionS: 300,
  minTripCoverage: 0.9,
  bunchingShare: 0.25,
  bands: [
    { id: "am", fromS: 6 * 3600, toS: 9 * 3600 },
    { id: "midday", fromS: 9 * 3600, toS: 15 * 3600 },
  ],
};
const DAY = Date.parse("2026-09-29T07:00:00Z"); // service day start (local midnight, UTC−7)
// Trips every 10 min from 07:00, each 20 min long, stops A (timepoint) → B → C (timepoint).
const trips: ScheduledTrip[] = Array.from({ length: 6 }, (_, i) => {
  const dep = 7 * 3600 + i * 600;
  return {
    tripId: `t${i}`,
    routeId: "r1",
    routeShortName: "R1",
    directionId: 0,
    firstDepS: dep,
    lastArrS: dep + 1200,
    stops: [
      { stopId: "A", schedS: dep, timepoint: true },
      { stopId: "B", schedS: dep + 600, timepoint: false },
      { stopId: "C", schedS: dep + 1200, timepoint: true },
    ],
  };
});
const at = (s: number) => DAY + s * 1000;

describe("routeStats", () => {
  it("counts punctuality at timepoints of covered trips, and headways at the busiest stop", () => {
    const delaysAtA = [0, 30, 240, -90, 0]; // t5 is cancelled
    const observed = delaysAtA.flatMap((d, i) => [
      {
        tripId: `t${i}`,
        stopId: "A",
        schedS: trips[i]!.firstDepS,
        timepoint: true,
        observedAt: at(trips[i]!.firstDepS + d),
        precisionS: 60,
      },
      {
        tripId: `t${i}`,
        stopId: "B",
        schedS: trips[i]!.firstDepS + 600,
        timepoint: false,
        observedAt: at(trips[i]!.firstDepS + 600 + d),
        precisionS: 60,
      },
    ]);
    const [day, am] = routeStats(
      {
        dayStart: DAY,
        trips,
        observed,
        cancelled: new Set(["t5"]),
        skipped: new Map([["t1", 2]]),
        coverage: [[at(6 * 3600), at(12 * 3600)]],
        coverageSlackMs: 0,
      },
      cfg,
    );
    expect(day!.band).toBe("day");
    expect(am!.band).toBe("am");
    expect(day!.coverage).toBe(1);
    expect(day!.metrics).toMatchObject({
      tripsScheduled: 6,
      tripsCovered: 6,
      tripsObserved: 5,
      tripsCancelled: 1,
      stopsSkipped: 2,
      timepoints: 5,
      onTime: 0.6,
      early: 0.2,
      late: 0.2,
      delayP50S: 0,
      headwayStopId: "A",
      headwaysDelivered: 4,
      scheduledGapP90S: 600,
    });
    // Gaps at A: 630, 810, 270, 690 s.
    expect(day!.metrics.deliveredGapP90S).toBe(
      Math.round(690 + (810 - 690) * 0.7),
    );
  });

  it("reports a recording gap as missing coverage, not as missed trips", () => {
    const [day] = routeStats(
      {
        dayStart: DAY,
        trips,
        observed: [],
        cancelled: new Set(),
        skipped: new Map(),
        coverage: [],
        coverageSlackMs: 0,
      },
      cfg,
    );
    expect(day!.coverage).toBe(0);
    expect(day!.metrics.tripsCovered).toBe(0);
    expect(day!.metrics.onTime).toBeNull();
  });
});
