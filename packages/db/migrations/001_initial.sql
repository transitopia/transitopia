-- Transitopia V2 database, Phase 2 (V2-PLAN.md §4.4): what the server records, derives and curates.
-- Later phases add stations, fleet, photos, annotations, reports and datasets in their own migrations.
--
-- Times are timestamptz; service dates are `date` (the transit day, which runs past midnight).
-- Tables that grow with every poll are partitioned (by UTC day for raw data, so retention is
-- dropping a partition; by month for observed stop times), and partitions are created ahead of
-- time by the server (packages/db/src/partitions.ts).

create extension if not exists postgis;

create table regions (
  id text primary key,
  name text not null,
  timezone text not null
);
insert into regions (id, name, timezone)
values ('metro-vancouver', 'Metro Vancouver', 'America/Vancouver');

-- The process that polls, records and dispatches (V2-PLAN.md §4.3). Leadership itself is a session
-- advisory lock; this row only tells the others where to forward /rt/* requests.
create table service_leader (
  region_id text primary key references regions,
  instance text not null,
  url text,
  pid integer,
  started_at timestamptz not null,
  heartbeat_at timestamptz not null
);

-- Every upstream request, successful or not (V2-PLAN.md §4.5): the daily cap is enforced against
-- this, so restarts and retries count.
create table upstream_requests (
  id bigserial primary key,
  provider text not null,
  feed text not null,
  ts timestamptz not null,
  status integer,
  bytes integer,
  error text
);
create index upstream_requests_provider_ts on upstream_requests (provider, ts);

-- One row per poll (GTFS-RT positions) or AIS batch: the coverage record.
create table rt_polls (
  region_id text not null references regions,
  source text not null check (source in ('gtfs-rt', 'ais')),
  fetched_at timestamptz not null,
  header_ts timestamptz,
  vehicles integer not null,
  primary key (region_id, source, fetched_at)
);

-- Raw vehicle positions from every poll, for every route (not just the ones drawn). 60 days.
create table rt_positions (
  region_id text not null,
  fetched_at timestamptz not null,
  vehicle_id text not null,
  label text,
  trip_id text,
  route_id text,
  -- Our route key when the route is drawn (e.g. "99"), else null.
  route_key text,
  lat double precision not null,
  lon double precision not null,
  bearing real,
  -- The fix's own time (vehicle timestamp, falling back to the feed header).
  ts timestamptz not null,
  stop_seq integer,
  stop_id text,
  status smallint,
  -- Seconds late (+) or early (−) at the next stop, from the latest trip updates.
  delay integer
) partition by range (fetched_at);
create index on rt_positions (fetched_at);
create index on rt_positions (trip_id, ts);

-- Raw AIS fixes (SeaBus). 60 days.
create table ais_fixes (
  region_id text not null,
  received_at timestamptz not null,
  mmsi text not null,
  name text,
  ts timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  sog real,
  cog real
) partition by range (received_at);
create index on ais_fixes (ts);

-- Trips TransLink reported cancelled or skipping stops, per service date, for every route.
create table trip_changes (
  region_id text not null references regions,
  service_date date not null,
  trip_id text not null,
  route_id text,
  cancelled boolean not null,
  skipped_stop_ids text[] not null default '{}',
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  primary key (region_id, service_date, trip_id)
);

-- GTFS-RT alerts (every route and line), with first and last sighting. The latest wording wins.
create table alerts (
  region_id text not null references regions,
  alert_id text not null,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  cause integer,
  effect integer,
  header text not null,
  description text not null,
  periods jsonb not null,
  entities jsonb not null,
  primary key (region_id, alert_id)
);

-- Curated corrections (V2-PLAN.md §5.6). `body` is the file format (packages/transit-core
-- corrections/types.ts ObservationFile, disruption/types.ts Disruption); `state` is the review state.
-- Only confirmed entries apply; `previewing` ones are dispatched on request as preview versions.
create table observation_sets (
  id text primary key,
  region_id text not null references regions,
  state text not null check (state in ('draft', 'previewing', 'confirmed', 'discarded')),
  title text not null,
  body jsonb not null,
  -- Service dates it touches (YYYY-MM-DD), for lookups.
  dates date[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  reviewed_by text,
  reviewed_at timestamptz
);

create table disruptions (
  id text primary key,
  region_id text not null references regions,
  state text not null check (state in ('draft', 'previewing', 'confirmed', 'discarded')),
  body jsonb not null,
  dates date[] not null,
  alert_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  reviewed_by text,
  reviewed_at timestamptz
);

-- Dispatch patch versions (the patches themselves are files). `kind` = live (what clients get) or
-- preview (a candidate correction dispatched for review, reachable only by its link).
create table dispatch_versions (
  region_id text not null references regions,
  service_date date not null,
  version text not null,
  kind text not null check (kind in ('live', 'preview')),
  preview_of text,
  inputs jsonb not null,
  created_at timestamptz not null default now(),
  primary key (region_id, service_date, version)
);

-- GTFS static feeds, kept indefinitely (the zips in object storage).
create table gtfs_feeds (
  region_id text not null references regions,
  version text not null,
  start_date date not null,
  end_date date not null,
  fetched_at timestamptz not null,
  sha256 text not null,
  bytes bigint not null,
  object_key text,
  primary key (region_id, version)
);

-- Observed stop times (V2-PLAN.md §4.4): per trip and stop, when the vehicle was there, derived
-- from raw positions while they exist. Kept indefinitely; the atom behind every statistic.
create table observed_stop_times (
  region_id text not null,
  service_date date not null,
  trip_id text not null,
  stop_sequence integer not null,
  stop_id text not null,
  route_id text not null,
  direction_id smallint,
  vehicle_id text,
  -- Scheduled departure in seconds since the service day's start (GTFS time; can exceed 24 h).
  scheduled_s integer not null,
  timepoint boolean not null,
  observed_at timestamptz not null,
  -- Seconds between the two fixes it was interpolated from (0: reported stopped at the stop).
  precision_s integer not null,
  stats_version integer not null,
  primary key (region_id, service_date, trip_id, stop_sequence)
) partition by range (service_date);

-- Per-route statistics per service date and time band, kept indefinitely. `coverage` is the share
-- of the scheduled trips' time the recorder was running: a gap is a gap, never a zero.
create table route_stats_daily (
  region_id text not null references regions,
  service_date date not null,
  route_id text not null,
  route_short_name text,
  direction_id smallint not null,
  band text not null,
  metrics jsonb not null,
  coverage real not null,
  stats_version integer not null,
  computed_at timestamptz not null default now(),
  primary key (region_id, service_date, route_id, direction_id, band)
);

-- Scheduled and catch-up jobs (packages/db/src/jobs.ts): one row per job and key (e.g. a date).
create table job_runs (
  job text not null,
  key text not null,
  status text not null check (status in ('running', 'done', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  error text,
  detail jsonb,
  primary key (job, key)
);

-- Admins sign in with GitHub (V2-PLAN.md §4.3). Everyone else is anonymous until Phase 5.
create table users (
  id bigserial primary key,
  github_id bigint not null unique,
  login text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id bigint not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
