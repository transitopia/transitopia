// The daily statistics job for one feed's finished service date (docs/DESIGN.md#retention-and-statistics): observed stop
// times from the raw positions (while they exist: 60 days), then per-route statistics from those.
// Every route the feed reports, not just the ones we draw.

import { recordingConfig as recording } from "../config.ts";
import type {
  FeedInfo,
  FeedRealtime,
} from "@transitopia/transit-core/config.ts";
import type { Db } from "@transitopia/db/connect.ts";
import { sql } from "kysely";
import { ensurePartitionsFor } from "@transitopia/db/partitions.ts";
import { isoDate } from "../dates.ts";
import {
  feedZipFor,
  loadDayTimetable,
  type DayTrip,
} from "@transitopia/data/gtfs-day.ts";
import { readFeedConfig } from "@transitopia/data/paths.ts";
import type { LonLat } from "@transitopia/transit-core/geo.ts";
import { cadence } from "@transitopia/transit-core/rt/budget.ts";
import {
  frozenFixes,
  type FreezeFix,
  type FrozenGpsConfig,
} from "@transitopia/transit-core/rt/stale.ts";
import { extendCoverage } from "@transitopia/transit-core/rt/types.ts";
import {
  observeTrip,
  type TripFix,
} from "@transitopia/transit-core/rt/observed.ts";
import {
  routeStats,
  STATS_VERSION,
  type ObservedRow,
} from "@transitopia/transit-core/rt/stats.ts";
import {
  serviceDayStart,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";

const CHUNK = 2000;
/** Positions this long after the service day's start can still belong to it (ms). */
const DAY_SPAN_MS = 32 * 3_600_000;

export interface DailyResult {
  feedVersion: string;
  tripsWithFixes: number;
  observedStops: number;
  statsRows: number;
}

/** A feed with real-time data, whose statistics can be computed. */
export type RealtimeFeed = Pick<FeedInfo, "id"> & {
  realtime: FeedRealtime;
};

/** A feed's observed stop times and statistics for a service date (YYYYMMDD). Replaces earlier results. */
export async function dailyStats(
  db: Db,
  feed: RealtimeFeed,
  date: ServiceDate,
  log: (msg: string) => void = () => {},
): Promise<DailyResult> {
  const zip = await feedZipFor(feed.id, date);
  if (!zip) throw new Error(`no archived ${feed.id} GTFS feed covers ${date}`);
  const tt = await loadDayTimetable(zip, date);
  const coverageGapMs = cadence(feed.realtime).coverageGapMs;
  const dayStart = serviceDayStart(date);
  const from = new Date(dayStart);
  const to = new Date(dayStart + DAY_SPAN_MS);

  // Trips by route, so each query stays small.
  const byRoute = new Map<string, DayTrip[]>();
  for (const t of tt.trips.values()) {
    let l = byRoute.get(t.routeId);
    if (!l) byRoute.set(t.routeId, (l = []));
    l.push(t);
  }
  const frozen = await frozenPositions(
    db,
    feed.id,
    from,
    to,
    tt.trips.values(),
    (await readFeedConfig(feed.id)).rt.frozenGps,
  );
  const observed: (ObservedRow & {
    routeId: string;
    directionId: number;
    seq: number;
    vehicleId: string;
  })[] = [];
  let tripsWithFixes = 0;
  for (const trips of byRoute.values()) {
    const rows = await db
      .selectFrom("rt_positions")
      .select([
        "trip_id",
        "vehicle_id",
        "ts",
        "lat",
        "lon",
        "status",
        "stop_seq",
      ])
      .distinct()
      .where("feed_id", "=", feed.id)
      .where("fetched_at", ">=", from)
      .where("fetched_at", "<", to)
      .where(
        "trip_id",
        "in",
        trips.map((t) => t.tripId),
      )
      .execute();
    const fixes = new Map<string, TripFix[]>();
    for (const r of rows) {
      if (frozen.has(`${r.vehicle_id}@${r.ts.getTime()}`)) continue;
      let l = fixes.get(r.trip_id!);
      if (!l) fixes.set(r.trip_id!, (l = []));
      l.push({
        ts: r.ts.getTime(),
        lat: r.lat,
        lon: r.lon,
        vehicleId: r.vehicle_id,
        status: r.status ?? undefined,
        stopSeq: r.stop_seq ?? undefined,
      });
    }
    for (const t of trips) {
      const f = fixes.get(t.tripId);
      const shape = tt.shapes.get(t.shapeId);
      if (!f || !shape) continue;
      tripsWithFixes++;
      for (const o of observeTrip(shape, t.stops, f, recording.observed))
        observed.push({
          tripId: t.tripId,
          routeId: t.routeId,
          directionId: t.directionId,
          seq: o.seq,
          stopId: o.stopId,
          schedS: o.schedS,
          timepoint: o.timepoint,
          observedAt: o.observedAt,
          precisionS: o.precisionS,
          vehicleId: o.vehicleId,
        });
    }
  }
  log(
    `${feed.id} ${date}: ${observed.length} observed stop times from ${tripsWithFixes} trips (feed ${tt.feedVersion}; ${frozen.size} frozen fixes left out)`,
  );

  await ensurePartitionsFor(db, dayStart, dayStart);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("observed_stop_times")
      .where("feed_id", "=", feed.id)
      .where("service_date", "=", isoDate(date))
      .execute();
    for (let i = 0; i < observed.length; i += CHUNK)
      await tx
        .insertInto("observed_stop_times")
        .values(
          observed.slice(i, i + CHUNK).map((o) => ({
            feed_id: feed.id,
            service_date: isoDate(date),
            trip_id: o.tripId,
            stop_sequence: o.seq,
            stop_id: o.stopId,
            route_id: o.routeId,
            direction_id: o.directionId,
            vehicle_id: o.vehicleId,
            scheduled_s: o.schedS,
            timepoint: o.timepoint,
            observed_at: new Date(o.observedAt),
            precision_s: o.precisionS,
            stats_version: STATS_VERSION,
            feed_version: tt.feedVersion,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
  });

  // Recorder coverage over the day, from the polls table: polls without vehicles don't count
  // (apps/server/src/rt/recorder.ts, emptyIsGap).
  const polls = await db
    .selectFrom("rt_polls")
    .select("fetched_at")
    .where("feed_id", "=", feed.id)
    .where("source", "=", "gtfs-rt")
    .where("vehicles", ">", 0)
    .where("fetched_at", ">=", from)
    .where("fetched_at", "<", to)
    .orderBy("fetched_at")
    .execute();
  const coverage: [number, number][] = [];
  for (const p of polls) {
    const t = p.fetched_at.getTime();
    extendCoverage(coverage, t, coverageGapMs(t));
  }
  const changes = await db
    .selectFrom("trip_changes")
    .select(["trip_id", "cancelled", "skipped_stop_ids"])
    .where("feed_id", "=", feed.id)
    .where("service_date", "=", isoDate(date))
    .execute();
  const stats = routeStats(
    {
      dayStart,
      trips: [...tt.trips.values()]
        .filter((t) => t.stops.length)
        .map((t) => ({
          tripId: t.tripId,
          routeId: t.routeId,
          routeShortName: t.routeShortName,
          directionId: t.directionId,
          firstDepS: t.stops[0]!.schedS,
          lastArrS: t.stops[t.stops.length - 1]!.schedS,
          stops: t.stops,
        })),
      observed,
      cancelled: new Set(
        changes.filter((c) => c.cancelled).map((c) => c.trip_id),
      ),
      skipped: new Map(
        changes
          .filter((c) => !c.cancelled)
          .map((c) => [c.trip_id, c.skipped_stop_ids.length]),
      ),
      coverage,
      // Polls further apart than the schedule's interval already broke the coverage above.
      coverageSlackMs: 0,
    },
    recording.stats,
  );
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("route_stats_daily")
      .where("feed_id", "=", feed.id)
      .where("service_date", "=", isoDate(date))
      .execute();
    for (let i = 0; i < stats.length; i += CHUNK)
      await tx
        .insertInto("route_stats_daily")
        .values(
          stats.slice(i, i + CHUNK).map((s) => ({
            feed_id: feed.id,
            service_date: isoDate(date),
            route_id: s.routeId,
            route_short_name: s.routeShortName ?? null,
            direction_id: s.directionId,
            band: s.band,
            metrics: JSON.stringify(s.metrics),
            coverage: s.coverage,
            stats_version: STATS_VERSION,
            feed_version: tt.feedVersion,
          })),
        )
        .execute();
  });
  return {
    feedVersion: tt.feedVersion,
    tripsWithFixes,
    observedStops: observed.length,
    statsRows: stats.length,
  };
}

/** Whether any positions poll of a feed was recorded during a service date (YYYYMMDD). */
export async function hasRecording(
  db: Db,
  feedId: string,
  date: ServiceDate,
): Promise<boolean> {
  const start = serviceDayStart(date);
  const row = await db
    .selectFrom("rt_polls")
    .select("fetched_at")
    .where("feed_id", "=", feedId)
    .where("source", "=", "gtfs-rt")
    .where("fetched_at", ">=", new Date(start))
    .where("fetched_at", "<", new Date(start + DAY_SPAN_MS))
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * The day's fixes whose position is frozen GPS (packages/transit-core/src/rt/stale.ts), as
 * `<vehicle id>@<epoch ms>`. Per vehicle over all its trips, since a freeze can run from one trip
 * into the next: only fixes repeating a neighbour's position come back from the database, each with
 * its row number (where runs break) and the next fix's position (where the bus reappeared).
 */
async function frozenPositions(
  db: Db,
  feedId: string,
  from: Date,
  to: Date,
  trips: Iterable<DayTrip>,
  cfg: FrozenGpsConfig,
): Promise<Set<string>> {
  const stopAt = new Map<string, LonLat>();
  for (const t of trips)
    for (const s of t.stops) stopAt.set(s.stopId, [s.lon, s.lat]);
  const { rows } = await sql<{
    vehicle_id: string;
    ts: Date;
    lat: number;
    lon: number;
    trip_id: string | null;
    stop_id: string | null;
    rn: number;
    next_lat: number | null;
    next_lon: number | null;
  }>`
    select vehicle_id, ts, lat, lon, trip_id, stop_id, rn, next_lat, next_lon from (
      select *,
        row_number() over w as rn,
        lag(lat) over w as prev_lat, lag(lon) over w as prev_lon,
        lead(lat) over w as next_lat, lead(lon) over w as next_lon
      from (
        select distinct on (vehicle_id, ts) vehicle_id, ts, lat, lon, trip_id, stop_id
        from rt_positions
        where feed_id = ${feedId} and fetched_at >= ${from} and fetched_at < ${to}
        order by vehicle_id, ts, fetched_at
      ) fixes
      window w as (partition by vehicle_id order by ts)
    ) runs
    where (lat = prev_lat and lon = prev_lon) or (lat = next_lat and lon = next_lon)
    order by vehicle_id, ts`.execute(db);
  const out = new Set<string>();
  let seg: typeof rows = [];
  const flush = () => {
    if (!seg.length) return;
    const last = seg[seg.length - 1]!;
    const fixes: FreezeFix[] = seg.map((r) => ({
      lat: r.lat,
      lon: r.lon,
      tripId: r.trip_id ?? undefined,
      stop: r.stop_id ?? undefined,
      stopAt: r.stop_id ? stopAt.get(r.stop_id) : undefined,
    }));
    // Where the bus reappeared, if it did: it ends the last run.
    if (last.next_lat !== null && last.next_lon !== null)
      fixes.push({
        lat: last.next_lat,
        lon: last.next_lon,
        tripId: undefined,
        stop: undefined,
        stopAt: undefined,
      });
    for (const k of frozenFixes(fixes, cfg))
      out.add(`${seg[k]!.vehicle_id}@${seg[k]!.ts.getTime()}`);
    seg = [];
  };
  for (const r of rows) {
    const prev = seg[seg.length - 1];
    if (prev && (prev.vehicle_id !== r.vehicle_id || prev.rn + 1 !== r.rn))
      flush();
    seg.push(r);
  }
  flush();
  return out;
}
