// Kysely types for the tables in migrations/. Keep in step with the SQL: a column added there is
// added here. Service dates (`date`) come back as "YYYY-MM-DD" strings (connect.ts), timestamps as
// Date objects, bigints as numbers.

import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** A timestamp with a database default (`now()`). */
type DefaultTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
/** A `date` column: "YYYY-MM-DD". */
type DateString = string;
type Json<T> = ColumnType<T, string, string>;

export type ReviewState = "draft" | "previewing" | "confirmed" | "discarded";

export interface Database {
  regions: { id: string; name: string; timezone: string };
  service_leader: {
    region_id: string;
    instance: string;
    url: string | null;
    pid: number | null;
    started_at: Timestamp;
    heartbeat_at: Timestamp;
  };
  upstream_requests: {
    id: Generated<number>;
    provider: string;
    feed: string;
    ts: Timestamp;
    status: number | null;
    bytes: number | null;
    error: string | null;
  };
  rt_polls: {
    region_id: string;
    source: "gtfs-rt" | "ais";
    fetched_at: Timestamp;
    header_ts: Timestamp | null;
    vehicles: number;
  };
  rt_positions: {
    region_id: string;
    fetched_at: Timestamp;
    vehicle_id: string;
    label: string | null;
    trip_id: string | null;
    route_id: string | null;
    route_key: string | null;
    lat: number;
    lon: number;
    bearing: number | null;
    ts: Timestamp;
    stop_seq: number | null;
    stop_id: string | null;
    status: number | null;
    delay: number | null;
  };
  ais_fixes: {
    region_id: string;
    received_at: Timestamp;
    mmsi: string;
    name: string | null;
    ts: Timestamp;
    lat: number;
    lon: number;
    sog: number | null;
    cog: number | null;
  };
  trip_changes: {
    region_id: string;
    service_date: DateString;
    trip_id: string;
    route_id: string | null;
    cancelled: boolean;
    skipped_stop_ids: string[];
    first_seen: Timestamp;
    last_seen: Timestamp;
  };
  alerts: {
    region_id: string;
    alert_id: string;
    first_seen: Timestamp;
    last_seen: Timestamp;
    cause: number | null;
    effect: number | null;
    header: string;
    description: string;
    periods: Json<{ start?: number; end?: number }[]>;
    entities: Json<
      {
        routeId?: string;
        stopId?: string;
        directionId?: number;
        tripId?: string;
      }[]
    >;
  };
  observation_sets: {
    id: string;
    region_id: string;
    state: ReviewState;
    title: string;
    body: Json<unknown>;
    dates: DateString[];
    created_at: DefaultTimestamp;
    updated_at: DefaultTimestamp;
    created_by: string | null;
    reviewed_by: string | null;
    reviewed_at: Timestamp | null;
  };
  disruptions: {
    id: string;
    region_id: string;
    state: ReviewState;
    body: Json<unknown>;
    dates: DateString[];
    alert_id: string | null;
    created_at: DefaultTimestamp;
    updated_at: DefaultTimestamp;
    created_by: string | null;
    reviewed_by: string | null;
    reviewed_at: Timestamp | null;
  };
  dispatch_versions: {
    region_id: string;
    service_date: DateString;
    version: string;
    kind: "live" | "preview";
    preview_of: string | null;
    inputs: Json<unknown>;
    created_at: DefaultTimestamp;
  };
  gtfs_feeds: {
    region_id: string;
    version: string;
    start_date: DateString;
    end_date: DateString;
    fetched_at: Timestamp;
    sha256: string;
    bytes: number;
    object_key: string | null;
  };
  observed_stop_times: {
    region_id: string;
    service_date: DateString;
    trip_id: string;
    stop_sequence: number;
    stop_id: string;
    route_id: string;
    direction_id: number | null;
    vehicle_id: string | null;
    scheduled_s: number;
    timepoint: boolean;
    observed_at: Timestamp;
    precision_s: number;
    stats_version: number;
  };
  route_stats_daily: {
    region_id: string;
    service_date: DateString;
    route_id: string;
    route_short_name: string | null;
    direction_id: number;
    band: string;
    metrics: Json<unknown>;
    coverage: number;
    stats_version: number;
    computed_at: DefaultTimestamp;
  };
  job_runs: {
    job: string;
    key: string;
    status: "running" | "done" | "failed";
    started_at: Timestamp;
    finished_at: Timestamp | null;
    error: string | null;
    detail: Json<unknown> | null;
  };
  users: {
    id: Generated<number>;
    github_id: number;
    login: string;
    role: Generated<"user" | "admin">;
    created_at: DefaultTimestamp;
  };
  sessions: {
    token_hash: string;
    user_id: number;
    created_at: DefaultTimestamp;
    expires_at: Timestamp;
  };
  trackside_passes: {
    id: string;
    region_id: string;
    setup_id: string;
    started_at: Timestamp;
    ended_at: Timestamp;
    track: "near" | "far";
    bearing: number;
    speed_kmh: number | null;
    cars: string[];
    report: Json<unknown>;
    created_by: string | null;
    received_at: DefaultTimestamp;
  };
  trackside_crops: {
    pass_id: string;
    idx: number;
    reading: string;
    confidence: number;
    accepted: boolean;
    jpeg: Buffer;
    label: string | null;
  };
}
