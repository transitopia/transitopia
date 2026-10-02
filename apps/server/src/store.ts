// What the leader records in PostgreSQL (docs/DESIGN.md#where-data-lives): upstream requests (the budget ledger),
// raw positions and AIS fixes for every route, service changes and alerts, and dispatch versions.
// The hourly NDJSON files (recorder.ts) are written alongside; both expire after the retention period.

import { sql } from "kysely";
import type { Db } from "@transitopia/db/connect.ts";
import { ensurePartitionsFor } from "@transitopia/db/partitions.ts";
import type { PollFeed } from "@transitopia/transit-core/rt/budget.ts";
import type { AisFix } from "@transitopia/transit-core/ais/match.ts";
import type { DecodedAlert } from "./rt/upstream.ts";

export interface RecordedVehicle {
  id: string;
  label?: string | undefined;
  tripId?: string | undefined;
  routeId?: string | undefined;
  /** Our key when the route is drawn. */
  routeKey?: string | undefined;
  lat: number;
  lon: number;
  bearing?: number | undefined;
  ts: number;
  stopSeq?: number | undefined;
  stopId?: string | undefined;
  status?: number | undefined;
  delay?: number | undefined;
}

export interface TripChangeRow {
  /** Service date, YYYYMMDD. */
  date: string;
  tripId: string;
  routeId?: string | undefined;
  cancelled: boolean;
  skippedStopIds: string[];
}

/** Rows per INSERT (Postgres allows 65,535 parameters per statement). */
const CHUNK = 2000;
/** YYYYMMDD → YYYY-MM-DD, for date columns. */
const isoDate = (yyyymmdd: string) =>
  Temporal.PlainDate.from(yyyymmdd).toString();

export class Store {
  readonly db: Db;
  readonly regionId: string;

  constructor(db: Db, regionId: string) {
    this.db = db;
    this.regionId = regionId;
  }

  /** TransLink requests in the 24 hours before `now`, oldest first, for the in-memory ledger. */
  async recentRequests(
    provider: string,
    now = Date.now(),
  ): Promise<[number, PollFeed][]> {
    const rows = await this.db
      .selectFrom("upstream_requests")
      .select(["ts", "feed"])
      .where("provider", "=", provider)
      .where("ts", ">", new Date(now - 86_400_000))
      .orderBy("ts")
      .execute();
    return rows.map((r) => [r.ts.getTime(), r.feed as PollFeed]);
  }

  async recordRequest(r: {
    provider: string;
    feed: string;
    ts: number;
    status?: number | undefined;
    bytes?: number | undefined;
    error?: string | undefined;
  }): Promise<void> {
    await this.db
      .insertInto("upstream_requests")
      .values({
        provider: r.provider,
        feed: r.feed,
        ts: new Date(r.ts),
        status: r.status ?? null,
        bytes: r.bytes ?? null,
        error: r.error ?? null,
      })
      .execute();
  }

  /**
   * Run a write; if its partition doesn't exist yet (the daily job creates them ahead, but it may
   * not have run, e.g. right after an import or with jobs off), create it and try once more.
   */
  private async partitioned(
    t: number,
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write();
    } catch (e) {
      // 23514: no partition of relation … found for row.
      if ((e as { code?: string }).code !== "23514") throw e;
      await ensurePartitionsFor(this.db, t, t);
      await write();
    }
  }

  /** One positions poll: every vehicle, every route. */
  async recordPositions(
    fetchedAt: number,
    headerTs: number,
    vehicles: RecordedVehicle[],
  ): Promise<void> {
    const at = new Date(fetchedAt);
    await this.partitioned(fetchedAt, () =>
      this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto("rt_polls")
          .values({
            region_id: this.regionId,
            source: "gtfs-rt",
            fetched_at: at,
            header_ts: new Date(headerTs),
            vehicles: vehicles.length,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        for (let i = 0; i < vehicles.length; i += CHUNK)
          await tx
            .insertInto("rt_positions")
            .values(
              vehicles.slice(i, i + CHUNK).map((v) => ({
                region_id: this.regionId,
                fetched_at: at,
                vehicle_id: v.id,
                label: v.label ?? null,
                trip_id: v.tripId ?? null,
                route_id: v.routeId ?? null,
                route_key: v.routeKey ?? null,
                lat: v.lat,
                lon: v.lon,
                bearing: v.bearing ?? null,
                ts: new Date(v.ts),
                stop_seq: v.stopSeq ?? null,
                stop_id: v.stopId ?? null,
                status: v.status ?? null,
                delay: v.delay ?? null,
              })),
            )
            .execute();
      }),
    );
  }

  /** One batch of AIS fixes (an empty batch still marks coverage). */
  async recordAis(receivedAt: number, fixes: AisFix[]): Promise<void> {
    const at = new Date(receivedAt);
    await this.partitioned(receivedAt, () =>
      this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto("rt_polls")
          .values({
            region_id: this.regionId,
            source: "ais",
            fetched_at: at,
            header_ts: null,
            vehicles: fixes.length,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        if (fixes.length)
          await tx
            .insertInto("ais_fixes")
            .values(
              fixes.map((f) => ({
                region_id: this.regionId,
                received_at: at,
                mmsi: f.mmsi,
                name: f.name ?? null,
                ts: new Date(f.ts),
                lat: f.lat,
                lon: f.lon,
                sog: f.sog ?? null,
                cog: f.cog ?? null,
              })),
            )
            .execute();
      }),
    );
  }

  /** Trip changes from one trip-updates poll (every route): first and last sighting per trip. */
  async recordTripChanges(
    changes: TripChangeRow[],
    now = Date.now(),
  ): Promise<void> {
    if (!changes.length) return;
    const at = new Date(now);
    // One row per (date, trip) per statement: a poll can list a trip twice.
    const byKey = new Map<string, TripChangeRow>();
    for (const c of changes) byKey.set(`${c.date}|${c.tripId}`, c);
    const rows = [...byKey.values()];
    for (let i = 0; i < rows.length; i += CHUNK)
      await this.db
        .insertInto("trip_changes")
        .values(
          rows.slice(i, i + CHUNK).map((c) => ({
            region_id: this.regionId,
            service_date: isoDate(c.date),
            trip_id: c.tripId,
            route_id: c.routeId ?? null,
            cancelled: c.cancelled,
            skipped_stop_ids: c.skippedStopIds,
            first_seen: at,
            last_seen: at,
          })),
        )
        .onConflict((oc) =>
          oc.columns(["region_id", "service_date", "trip_id"]).doUpdateSet({
            last_seen: at,
            cancelled: sql`trip_changes.cancelled or excluded.cancelled`,
            skipped_stop_ids: sql`array(select distinct unnest(trip_changes.skipped_stop_ids || excluded.skipped_stop_ids))`,
          }),
        )
        .execute();
  }

  /** Alerts from one alerts poll (every route and line). The latest wording wins. */
  async recordAlerts(alerts: DecodedAlert[], now = Date.now()): Promise<void> {
    if (!alerts.length) return;
    const at = new Date(now);
    await this.db
      .insertInto("alerts")
      .values(
        alerts.map((a) => ({
          region_id: this.regionId,
          alert_id: a.id,
          first_seen: at,
          last_seen: at,
          cause: a.cause ?? null,
          effect: a.effect ?? null,
          header: a.header,
          description: a.description,
          periods: JSON.stringify(a.periods),
          entities: JSON.stringify([
            ...a.entities,
            ...a.stopIds.map((stopId) => ({ stopId })),
          ]),
        })),
      )
      .onConflict((oc) =>
        oc.columns(["region_id", "alert_id"]).doUpdateSet((eb) => ({
          last_seen: at,
          cause: eb.ref("excluded.cause"),
          effect: eb.ref("excluded.effect"),
          header: eb.ref("excluded.header"),
          description: eb.ref("excluded.description"),
          periods: eb.ref("excluded.periods"),
          entities: eb.ref("excluded.entities"),
        })),
      )
      .execute();
  }

  async recordDispatchVersion(v: {
    date: string;
    version: string;
    kind: "live" | "preview";
    previewOf?: string | undefined;
    inputs: unknown;
  }): Promise<void> {
    await this.db
      .insertInto("dispatch_versions")
      .values({
        region_id: this.regionId,
        service_date: isoDate(v.date),
        version: v.version,
        kind: v.kind,
        preview_of: v.previewOf ?? null,
        inputs: JSON.stringify(v.inputs),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
