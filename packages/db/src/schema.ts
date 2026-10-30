// Kysely types for the tables in migrations/. Keep in step with the SQL: a column added there is
// added here. Service dates (`date`) come back as "YYYY-MM-DD" strings (connect.ts), timestamps as
// Date objects, bigints as numbers.

import type { ColumnType, Generated } from "kysely";
import type { ReviewState } from "@transitopia/shared/admin-api.ts";
import type { FeatureKind } from "@transitopia/shared/features.ts";

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

export interface Database {
  regions: { id: string; name: string; timezone: string };
  operators: { id: string; name: string };
  feeds: { id: string; name: string; operator_id: string; timezone: string };
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
    feed_id: string;
    source: "gtfs-rt" | "ais";
    fetched_at: Timestamp;
    header_ts: Timestamp | null;
    vehicles: number;
  };
  rt_positions: {
    feed_id: string;
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
    feed_id: string;
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
    feed_id: string;
    service_date: DateString;
    trip_id: string;
    route_id: string | null;
    cancelled: boolean;
    skipped_stop_ids: string[];
    first_seen: Timestamp;
    last_seen: Timestamp;
  };
  alerts: {
    feed_id: string;
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
    feed_id: string;
    version: string;
    start_date: DateString;
    end_date: DateString;
    fetched_at: Timestamp;
    sha256: string;
    bytes: number;
    object_key: string | null;
    /** The order versions were archived in (feature_refs.versions). */
    seq: Generated<number>;
    reconciled_at: Timestamp | null;
  };
  observed_stop_times: {
    feed_id: string;
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
    feed_version: string | null;
  };
  route_stats_daily: {
    feed_id: string;
    service_date: DateString;
    route_id: string;
    route_short_name: string | null;
    direction_id: number;
    band: string;
    metrics: Json<unknown>;
    coverage: number;
    stats_version: number;
    feed_version: string | null;
    computed_at: DefaultTimestamp;
  };
  // The feature registry (docs/DESIGN.md#feature-ids). `geom` is a PostGIS geography: write and
  // read it with SQL (ST_MakePoint, ST_X), never as a value. It's a point (stations, exchanges,
  // stops), or null (routes, vehicles, and bike routes, whose extent is in cycling_routes).
  features: {
    id: string;
    kind: FeatureKind;
    operator_id: string | null;
    feed_id: string | null;
    parent_id: string | null;
    name: string;
    geom: ColumnType<unknown, unknown, unknown>;
    status: Generated<"active" | "retired" | "merged">;
    merged_into: string | null;
    created_at: DefaultTimestamp;
    updated_at: DefaultTimestamp;
  };
  feature_refs: {
    id: Generated<number>;
    feature_id: string;
    scheme: string;
    namespace: Generated<string>;
    ref: string;
    /** An int4range of gtfs_feeds.seq ("[3,8)"); unbounded ("(,)") for schemes without versions. */
    versions: ColumnType<string, string | undefined, string>;
    origin: "reconcile" | "admin" | "import";
    created_at: DefaultTimestamp;
  };
  feature_changes: {
    id: Generated<number>;
    feature_id: string;
    action: string;
    before: Json<unknown> | null;
    after: Json<unknown> | null;
    user_id: number | null;
    created_at: DefaultTimestamp;
  };
  feature_flags: {
    id: Generated<number>;
    feature_id: string;
    candidates: ColumnType<string[], string[] | undefined, string[]>;
    reason: string;
    detail: Json<unknown> | null;
    state: Generated<"open" | "resolved">;
    resolution: string | null;
    resolved_by: number | null;
    created_at: DefaultTimestamp;
    resolved_at: Timestamp | null;
  };
  // Bike routes from the latest cycling build of each area (migrations/004_cycling_routes.sql).
  cycling_builds: {
    area: string;
    osm_file: string;
    osm_timestamp: Timestamp;
    built_at: Timestamp;
    loaded_at: DefaultTimestamp;
  };
  cycling_routes: {
    area: string;
    relation_id: number;
    name: string | null;
    ref: string | null;
    network: string | null;
    length_m: number;
    /** Metres by comfort, 0 (no bike facility) to 4. */
    comfort_m: number[];
    /** [west, south, east, north]. */
    bbox: number[] | null;
  };
  cycling_route_members: {
    area: string;
    parent: number;
    child: number;
    position: number;
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
}
