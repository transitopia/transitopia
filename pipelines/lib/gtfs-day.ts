// One service date's whole timetable, every route (unlike plan.json, which has only the routes we
// draw), read from the archived GTFS zips in var/raw/gtfs/. For observed stop times and statistics,
// which cover every bus route (V2-PLAN.md §4.4).

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readCsv, readCsvAll } from "./gtfs-zip.ts";
import { GTFS_RAW_DIR } from "./paths.ts";
import { activeServices } from "@transitopia/transit-core/gtfs/calendar.ts";
import { parseGtfsTime } from "@transitopia/transit-core/time.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";

export interface FeedZip {
  version: string;
  /** YYYYMMDD, inclusive. */
  start: string;
  end: string;
  path: string;
}

/** Archived feeds, newest first (by start date, then version). */
export async function archivedFeeds(dir = GTFS_RAW_DIR): Promise<FeedZip[]> {
  if (!existsSync(dir)) return [];
  const out: FeedZip[] = [];
  for (const v of await readdir(dir)) {
    const path = join(dir, v, "google_transit.zip");
    if (!existsSync(path)) continue;
    const [info] = await readCsvAll(path, "feed_info.txt");
    if (!info?.feed_start_date || !info.feed_end_date) continue;
    out.push({
      version: v,
      start: info.feed_start_date,
      end: info.feed_end_date,
      path,
    });
  }
  return out.sort((a, b) =>
    a.start !== b.start ?
      a.start < b.start ?
        1
      : -1
    : a.version < b.version ? 1
    : -1,
  );
}

/** The newest archived feed covering a service date (YYYYMMDD). */
export async function feedZipFor(
  date: string,
  dir = GTFS_RAW_DIR,
): Promise<FeedZip | undefined> {
  return (await archivedFeeds(dir)).find(
    (f) => f.start <= date && date <= f.end,
  );
}

export interface DayTrip {
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeType: number;
  directionId: number;
  shapeId: string;
  stops: {
    seq: number;
    stopId: string;
    lon: number;
    lat: number;
    /** Departure, seconds since the service day's start. */
    schedS: number;
    timepoint: boolean;
  }[];
}

export interface DayTimetable {
  feedVersion: string;
  trips: Map<string, DayTrip>;
  shapes: Map<string, LonLat[]>;
}

/** Everything running on a service date (YYYYMMDD) in `feed`. */
export async function loadDayTimetable(
  feed: FeedZip,
  date: string,
): Promise<DayTimetable> {
  const zip = feed.path;
  const calendar = (await readCsvAll(zip, "calendar.txt")).map((r) => ({
    serviceId: r.service_id!,
    days: [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].map((d) => r[d] === "1"),
    start: r.start_date!,
    end: r.end_date!,
  }));
  const exceptions = (await readCsvAll(zip, "calendar_dates.txt"))
    .filter((r) => r.date === date)
    .map((r) => ({
      serviceId: r.service_id!,
      date: r.date!,
      type: (r.exception_type === "1" ? 1 : 2) as 1 | 2,
    }));
  const services = activeServices({ calendar, exceptions }, date);
  const routes = new Map<string, { shortName: string; type: number }>();
  for await (const r of readCsv(zip, "routes.txt"))
    routes.set(r.route_id!, {
      shortName: r.route_short_name || r.route_long_name || r.route_id!,
      type: Number(r.route_type ?? 3),
    });
  const trips = new Map<string, DayTrip>();
  for await (const r of readCsv(zip, "trips.txt")) {
    if (!services.has(r.service_id!)) continue;
    const route = routes.get(r.route_id!);
    trips.set(r.trip_id!, {
      tripId: r.trip_id!,
      routeId: r.route_id!,
      routeShortName: route?.shortName ?? r.route_id!,
      routeType: route?.type ?? 3,
      directionId: Number(r.direction_id ?? 0),
      shapeId: r.shape_id ?? "",
      stops: [],
    });
  }
  const stopCoords = new Map<string, LonLat>();
  for await (const r of readCsv(zip, "stops.txt"))
    stopCoords.set(r.stop_id!, [Number(r.stop_lon), Number(r.stop_lat)]);
  for await (const r of readCsv(zip, "stop_times.txt")) {
    const trip = trips.get(r.trip_id!);
    if (!trip) continue;
    const c = stopCoords.get(r.stop_id!);
    if (!c) continue;
    const time = r.departure_time || r.arrival_time;
    if (!time) continue;
    trip.stops.push({
      seq: Number(r.stop_sequence),
      stopId: r.stop_id!,
      lon: c[0],
      lat: c[1],
      schedS: parseGtfsTime(time),
      // GTFS: timepoint 1 = exact, 0 = approximate; absent means exact.
      timepoint: r.timepoint !== "0",
    });
  }
  const usedShapes = new Set<string>();
  for (const t of trips.values()) {
    t.stops.sort((a, b) => a.seq - b.seq);
    if (t.shapeId) usedShapes.add(t.shapeId);
  }
  const points = new Map<string, [number, number, number][]>();
  for await (const r of readCsv(zip, "shapes.txt")) {
    if (!usedShapes.has(r.shape_id!)) continue;
    let l = points.get(r.shape_id!);
    if (!l) points.set(r.shape_id!, (l = []));
    l.push([
      Number(r.shape_pt_sequence),
      Number(r.shape_pt_lon),
      Number(r.shape_pt_lat),
    ]);
  }
  const shapes = new Map<string, LonLat[]>();
  for (const [id, l] of points)
    shapes.set(
      id,
      l.sort((a, b) => a[0] - b[0]).map(([, lon, lat]) => [lon, lat]),
    );
  return { feedVersion: feed.version, trips, shapes };
}
