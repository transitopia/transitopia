-- Feeds (docs/DESIGN.md#regions-and-feeds): what the server polls and records is per feed, not per
-- region, since a feed can be in several regions (a ferry between two) and a region can show
-- several feeds. Raw real-time data, service changes, alerts, GTFS feeds, observed stop times and
-- statistics move from region_id to feed_id. Corrections, dispatch versions and the leader row stay
-- the region's; AIS fixes too (they're the SeaBus's, in TransLink's feed: their polls in rt_polls
-- are recorded under it).
--
-- Every row so far is TransLink's. A column added with a constant default is metadata only (no
-- table rewrite, even on the partitioned tables), then the default is dropped: new rows name their
-- feed. Only the primary keys are rebuilt.

create table feeds (
  id text primary key,
  name text not null,
  agency text not null,
  timezone text not null
);
-- The server upserts every feed (config/feeds/*/feed.json) and region (config/regions/*/region.json) when it starts.
insert into feeds (id, name, agency, timezone)
values ('translink', 'TransLink', 'TransLink', 'America/Vancouver');

-- rt_polls: one row per poll of a feed, or AIS batch.
alter table rt_polls add column feed_id text not null default 'translink' references feeds;
alter table rt_polls alter column feed_id drop default;
alter table rt_polls drop constraint rt_polls_pkey;
alter table rt_polls add primary key (feed_id, source, fetched_at);
alter table rt_polls drop column region_id;

-- rt_positions (partitioned by day; no primary key).
alter table rt_positions add column feed_id text not null default 'translink';
alter table rt_positions alter column feed_id drop default;
alter table rt_positions drop column region_id;

alter table trip_changes add column feed_id text not null default 'translink' references feeds;
alter table trip_changes alter column feed_id drop default;
alter table trip_changes drop constraint trip_changes_pkey;
alter table trip_changes add primary key (feed_id, service_date, trip_id);
alter table trip_changes drop column region_id;

alter table alerts add column feed_id text not null default 'translink' references feeds;
alter table alerts alter column feed_id drop default;
alter table alerts drop constraint alerts_pkey;
alter table alerts add primary key (feed_id, alert_id);
alter table alerts drop column region_id;

-- gtfs_feeds: a feed's archived versions (version is the directory name, var/raw/gtfs/<feed>/<version>/).
alter table gtfs_feeds add column feed_id text not null default 'translink' references feeds;
alter table gtfs_feeds alter column feed_id drop default;
alter table gtfs_feeds drop constraint gtfs_feeds_pkey;
alter table gtfs_feeds add primary key (feed_id, version);
alter table gtfs_feeds drop column region_id;

-- observed_stop_times (partitioned by month).
alter table observed_stop_times add column feed_id text not null default 'translink';
alter table observed_stop_times alter column feed_id drop default;
alter table observed_stop_times drop constraint observed_stop_times_pkey;
alter table observed_stop_times add primary key (feed_id, service_date, trip_id, stop_sequence);
alter table observed_stop_times drop column region_id;

alter table route_stats_daily add column feed_id text not null default 'translink' references feeds;
alter table route_stats_daily alter column feed_id drop default;
alter table route_stats_daily drop constraint route_stats_daily_pkey;
alter table route_stats_daily add primary key (feed_id, service_date, route_id, direction_id, band);
alter table route_stats_daily drop column region_id;

-- The daily statistics job runs per feed now (key "<feed>:<service date>"): TransLink's runs so far
-- keep counting as done, so the dates they cover aren't recomputed.
update job_runs set key = 'translink:' || key where job = 'daily' and key !~ ':';
