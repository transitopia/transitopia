// Whether a GTFS export differs from an older one only by the dates that have passed rolling off
// (BC Transit re-exports every day, dropping yesterday's calendar dates and the trips of services
// that ran only then). For every date the newer export covers, the older one then gives the same
// timetable. See packages/transit-core/DESIGN.md#timetables.

import { createHash } from "node:crypto";
import { readCsv, zipEntrySignatures, type Row } from "./gtfs-zip.ts";
import {
  addDays,
  dayOfWeek,
  serviceDate,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";

/** A feed's files (name → signature, equal when the bytes are) and their rows. */
export interface GtfsSource {
  files: Map<string, string>;
  rows(name: string): AsyncIterable<Row>;
}

export async function zipSource(path: string): Promise<GtfsSource> {
  return {
    files: await zipEntrySignatures(path),
    rows: (name) => readCsv(path, name),
  };
}

/** The files that drop rows as dates pass; every other file must be the same. */
const ROLLING = new Set([
  "feed_info.txt",
  "calendar.txt",
  "calendar_dates.txt",
  "trips.txt",
  "stop_times.txt",
]);

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const rowKey = (row: Row) => JSON.stringify(row);

async function collect(src: GtfsSource, name: string): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const r of src.rows(name)) rows.push(r);
  return rows;
}

/** Rows of `older` missing from `newer`, or why `newer` isn't a subset of `older`. */
function removedRows(name: string, older: Row[], newer: Row[]): Row[] | string {
  const keys = new Set(older.map(rowKey));
  const kept = new Set<string>();
  for (const r of newer) {
    const k = rowKey(r);
    if (!keys.has(k)) return `${name} has rows the older export doesn't`;
    kept.add(k);
  }
  return older.filter((r) => !kept.has(rowKey(r)));
}

/** Services with at least one date on or after `from`. */
function servicesFrom(
  calendar: Row[],
  dates: Row[],
  from: ServiceDate,
): Set<string> {
  const live = new Set<string>();
  const removed = new Set<string>();
  for (const d of dates) {
    if (d.date! < from) continue;
    if (d.exception_type === "1") live.add(d.service_id!);
    else removed.add(`${d.service_id}:${d.date}`);
  }
  for (const c of calendar) {
    const id = c.service_id!;
    if (live.has(id) || c.end_date! < from) continue;
    const end = serviceDate(c.end_date!);
    for (
      let d = c.start_date! > from ? serviceDate(c.start_date!) : from;
      d <= end;
      d = addDays(d, 1)
    ) {
      if (c[WEEKDAYS[dayOfWeek(d)]!] === "1" && !removed.has(`${id}:${d}`)) {
        live.add(id);
        break;
      }
    }
  }
  return live;
}

/** An order-independent digest of each trip's stop times (a sum of row hashes, and a count). */
async function stopTimeDigests(src: GtfsSource): Promise<Map<string, string>> {
  const sums = new Map<string, { sum: bigint; n: number }>();
  for await (const r of src.rows("stop_times.txt")) {
    const h = createHash("sha1").update(rowKey(r)).digest().readBigUInt64LE(0);
    const t = sums.get(r.trip_id!);
    if (t) {
      t.sum = BigInt.asUintN(64, t.sum + h);
      t.n++;
    } else sums.set(r.trip_id!, { sum: h, n: 1 });
  }
  return new Map([...sums].map(([id, t]) => [id, `${t.sum}:${t.n}`]));
}

/**
 * Undefined when `newer` is `older` with only past dates removed (before the newer export's
 * feed_start_date): its calendar_dates rows, calendar rows that ended, and the trips (with their
 * stop times) of services with no date left. Otherwise, the first difference found.
 */
export async function rolloffDifference(
  older: GtfsSource,
  newer: GtfsSource,
): Promise<string | undefined> {
  const [oldInfo] = await collect(older, "feed_info.txt");
  const [newInfo] = await collect(newer, "feed_info.txt");
  if (!oldInfo?.feed_end_date || !newInfo?.feed_start_date)
    return "no feed_info.txt dates";
  if (oldInfo.feed_end_date !== newInfo.feed_end_date)
    return `feed_end_date changed (${oldInfo.feed_end_date} → ${newInfo.feed_end_date})`;
  const from = serviceDate(newInfo.feed_start_date);

  for (const name of new Set([...older.files.keys(), ...newer.files.keys()]))
    if (!ROLLING.has(name) && older.files.get(name) !== newer.files.get(name))
      return `${name} differs`;
  const same = (name: string) =>
    older.files.get(name) === newer.files.get(name);

  const oldCalendar = await collect(older, "calendar.txt");
  const oldDates = await collect(older, "calendar_dates.txt");
  if (!same("calendar.txt")) {
    const removed = removedRows(
      "calendar.txt",
      oldCalendar,
      await collect(newer, "calendar.txt"),
    );
    if (typeof removed === "string") return removed;
    const current = removed.find((r) => r.end_date! >= from);
    if (current)
      return `calendar.txt drops ${current.service_id}, still current`;
  }
  if (!same("calendar_dates.txt")) {
    const removed = removedRows(
      "calendar_dates.txt",
      oldDates,
      await collect(newer, "calendar_dates.txt"),
    );
    if (typeof removed === "string") return removed;
    const current = removed.find((r) => r.date! >= from);
    if (current)
      return `calendar_dates.txt drops ${current.service_id} on ${current.date}`;
  }

  const droppedTrips = new Set<string>();
  if (!same("trips.txt")) {
    const removed = removedRows(
      "trips.txt",
      await collect(older, "trips.txt"),
      await collect(newer, "trips.txt"),
    );
    if (typeof removed === "string") return removed;
    const live = servicesFrom(oldCalendar, oldDates, from);
    const current = removed.find((r) => live.has(r.service_id!));
    if (current)
      return `trips.txt drops ${current.trip_id}, whose service ${current.service_id} still runs`;
    for (const r of removed) droppedTrips.add(r.trip_id!);
  }

  if (!same("stop_times.txt")) {
    const oldTrips = await stopTimeDigests(older);
    for (const [trip, digest] of await stopTimeDigests(newer))
      if (oldTrips.get(trip) !== digest)
        return `stop_times.txt changes trip ${trip}`;
      else oldTrips.delete(trip);
    const kept = [...oldTrips.keys()].find((t) => !droppedTrips.has(t));
    if (kept) return `stop_times.txt drops trip ${kept}, still in trips.txt`;
  }
  return undefined;
}
