// The daily statistics job for one finished service date (V2-PLAN.md §4.4): observed stop times from
// the raw positions (while they exist: 60 days), then per-route statistics from those. Every route
// TransLink reports, not just the ones we draw.

import rtConfig from "@transitopia/region-metro-vancouver/config/rt.json" with { type: "json" };
import recording from "@transitopia/region-metro-vancouver/config/recording.json" with { type: "json" };
import type { Db } from "@transitopia/db/connect.ts";
import { ensurePartitionsFor } from "@transitopia/db/partitions.ts";
import {
  feedZipFor,
  loadDayTimetable,
  type DayTrip,
} from "@transitopia/pipelines/lib/gtfs-day.ts";
import {
  cadence,
  type CadenceConfig,
} from "@transitopia/transit-core/rt/budget.ts";
import { extendCoverage } from "@transitopia/transit-core/rt/types.ts";
import {
  observeTrip,
  type ObservedConfig,
  type TripFix,
} from "@transitopia/transit-core/rt/observed.ts";
import {
  routeStats,
  STATS_VERSION,
  type ObservedRow,
  type StatsConfig,
} from "@transitopia/transit-core/rt/stats.ts";
import { serviceDayStart } from "@transitopia/transit-core/time.ts";

const CADENCE = cadence(rtConfig as unknown as CadenceConfig);
const CHUNK = 2000;
/** Positions this long after the service day's start can still belong to it (ms). */
const DAY_SPAN_MS = 32 * 3_600_000;

const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

export interface DailyResult {
  feedVersion: string;
  tripsWithFixes: number;
  observedStops: number;
  statsRows: number;
}

/** Observed stop times and statistics for a service date (YYYYMMDD). Replaces earlier results. */
export async function dailyStats(
  db: Db,
  regionId: string,
  date: string,
  log: (msg: string) => void = () => {},
): Promise<DailyResult> {
  const feed = await feedZipFor(date);
  if (!feed) throw new Error(`no archived GTFS feed covers ${date}`);
  const tt = await loadDayTimetable(feed, date);
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
      .where("region_id", "=", regionId)
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
      for (const o of observeTrip(
        shape,
        t.stops,
        f,
        recording.observed as ObservedConfig,
      ))
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
    `${date}: ${observed.length} observed stop times from ${tripsWithFixes} trips (feed ${tt.feedVersion})`,
  );

  await ensurePartitionsFor(db, dayStart, dayStart);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("observed_stop_times")
      .where("region_id", "=", regionId)
      .where("service_date", "=", iso(date))
      .execute();
    for (let i = 0; i < observed.length; i += CHUNK)
      await tx
        .insertInto("observed_stop_times")
        .values(
          observed.slice(i, i + CHUNK).map((o) => ({
            region_id: regionId,
            service_date: iso(date),
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
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
  });

  // Recorder coverage over the day, from the polls table.
  const polls = await db
    .selectFrom("rt_polls")
    .select("fetched_at")
    .where("region_id", "=", regionId)
    .where("source", "=", "gtfs-rt")
    .where("fetched_at", ">=", from)
    .where("fetched_at", "<", to)
    .orderBy("fetched_at")
    .execute();
  const coverage: [number, number][] = [];
  for (const p of polls) {
    const t = p.fetched_at.getTime();
    extendCoverage(coverage, t, CADENCE.coverageGapMs(t));
  }
  const changes = await db
    .selectFrom("trip_changes")
    .select(["trip_id", "cancelled", "skipped_stop_ids"])
    .where("region_id", "=", regionId)
    .where("service_date", "=", iso(date))
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
    recording.stats as StatsConfig,
  );
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("route_stats_daily")
      .where("region_id", "=", regionId)
      .where("service_date", "=", iso(date))
      .execute();
    for (let i = 0; i < stats.length; i += CHUNK)
      await tx
        .insertInto("route_stats_daily")
        .values(
          stats.slice(i, i + CHUNK).map((s) => ({
            region_id: regionId,
            service_date: iso(date),
            route_id: s.routeId,
            route_short_name: s.routeShortName ?? null,
            direction_id: s.directionId,
            band: s.band,
            metrics: JSON.stringify(s.metrics),
            coverage: s.coverage,
            stats_version: STATS_VERSION,
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

/** Whether any positions poll was recorded during a service date (YYYYMMDD). */
export async function hasRecording(
  db: Db,
  regionId: string,
  date: string,
): Promise<boolean> {
  const start = serviceDayStart(date);
  const row = await db
    .selectFrom("rt_polls")
    .select("fetched_at")
    .where("region_id", "=", regionId)
    .where("source", "=", "gtfs-rt")
    .where("fetched_at", ">=", new Date(start))
    .where("fetched_at", "<", new Date(start + DAY_SPAN_MS))
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}
