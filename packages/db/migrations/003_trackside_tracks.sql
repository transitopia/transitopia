-- Trackside cameras see 1–3 tracks, not just a near and a far one (packages/trackside/README.md#setup).
-- `track` now holds the track's segment id (null when the device couldn't tell); `track_index` is
-- its place among the tracks in view, nearest first.
--
-- Passes stored before this came from the first test builds, with many false passes, and aren't
-- wanted (Braden, 2026-10-03): delete them (their crops go with them).

delete from trackside_passes;
alter table trackside_passes drop constraint trackside_passes_track_check;
alter table trackside_passes alter column track drop not null;
alter table trackside_passes add column track_index smallint;
