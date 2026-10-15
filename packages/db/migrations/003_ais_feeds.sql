-- AIS fixes are a feed's (config/feeds/<id>/feed.json → ais), like its GTFS-realtime: every fix so
-- far is TransLink's SeaBus. A column added with a constant default is metadata only, even on this
-- partitioned table; the default is then dropped.
alter table ais_fixes add column feed_id text not null default 'translink';
alter table ais_fixes alter column feed_id drop default;
alter table ais_fixes drop column region_id;
