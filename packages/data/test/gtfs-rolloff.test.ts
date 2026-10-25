import { describe, expect, it } from "vitest";
import type { Row } from "../src/gtfs-zip.ts";
import { rolloffDifference, type GtfsSource } from "../src/gtfs-rolloff.ts";

type Feed = Record<string, Row[]>;

const source = (feed: Feed): GtfsSource => ({
  files: new Map(
    Object.entries(feed).map(([name, rows]) => [name, JSON.stringify(rows)]),
  ),
  rows: async function* (name) {
    yield* feed[name] ?? [];
  },
});

const week = (id: string, start: string, end: string): Row => ({
  service_id: id,
  monday: "1",
  tuesday: "1",
  wednesday: "1",
  thursday: "1",
  friday: "1",
  saturday: "0",
  sunday: "0",
  start_date: start,
  end_date: end,
});
const trip = (id: string, service: string): Row => ({
  route_id: "r",
  service_id: service,
  trip_id: id,
});
const stops = (trip: string): Row[] => [
  { trip_id: trip, stop_sequence: "1", departure_time: "8:00:00" },
  { trip_id: trip, stop_sequence: "2", departure_time: "8:05:00" },
];

// Monday 2026-10-12 (Thanksgiving) has its own service; weekday service from the 13th.
const older: Feed = {
  "feed_info.txt": [{ feed_start_date: "20261012", feed_end_date: "20261219" }],
  "routes.txt": [{ route_id: "r" }],
  "calendar.txt": [week("wk", "20261013", "20261219")],
  "calendar_dates.txt": [
    { service_id: "hol", date: "20261012", exception_type: "1" },
    { service_id: "wk", date: "20261111", exception_type: "2" },
  ],
  "trips.txt": [trip("h1", "hol"), trip("w1", "wk")],
  "stop_times.txt": [...stops("h1"), ...stops("w1")],
};
const newer: Feed = {
  ...older,
  "feed_info.txt": [{ feed_start_date: "20261013", feed_end_date: "20261219" }],
  "calendar_dates.txt": [older["calendar_dates.txt"]![1]!],
  "trips.txt": [trip("w1", "wk")],
  "stop_times.txt": stops("w1").reverse(),
};
const diff = (a: Feed, b: Feed) => rolloffDifference(source(a), source(b));

describe("rolloffDifference", () => {
  it("accepts an export that only drops a date that has passed", async () => {
    expect(await diff(older, newer)).toBeUndefined();
  });

  it("rejects added or changed rows", async () => {
    expect(
      await diff(older, {
        ...newer,
        "stop_times.txt": [
          ...stops("w1").slice(0, 1),
          { trip_id: "w1", stop_sequence: "2", departure_time: "8:06:00" },
        ],
      }),
    ).toMatch(/stop_times.txt changes trip w1/);
    expect(
      await diff(older, {
        ...newer,
        "calendar_dates.txt": [
          { service_id: "wk", date: "20261112", exception_type: "2" },
        ],
      }),
    ).toMatch(/calendar_dates.txt has rows/);
  });

  it("rejects dropping dates and trips that are still to come", async () => {
    expect(
      await diff(older, {
        ...newer,
        "calendar_dates.txt": [],
      }),
    ).toMatch(/drops wk on 20261111/);
    expect(
      await diff(older, {
        ...newer,
        "trips.txt": [],
        "stop_times.txt": [],
      }),
    ).toMatch(/trips.txt drops w1/);
    expect(await diff(older, { ...newer, "stop_times.txt": [] })).toMatch(
      /stop_times.txt drops trip w1/,
    );
  });

  it("rejects other files changing and a new end date", async () => {
    expect(
      await diff(older, { ...newer, "routes.txt": [{ route_id: "s" }] }),
    ).toMatch(/routes.txt differs/);
    expect(
      await diff(older, {
        ...newer,
        "feed_info.txt": [
          { feed_start_date: "20261013", feed_end_date: "20261220" },
        ],
      }),
    ).toMatch(/feed_end_date changed/);
  });
});
