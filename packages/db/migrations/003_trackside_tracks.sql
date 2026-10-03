-- Trackside cameras see 1–3 tracks, not just a near and a far one (packages/trackside/README.md#setup).
-- `track` now holds the track's segment id (null when the device couldn't tell); rows from before
-- keep "near" or "far". `track_index` is its place among the tracks in view, nearest first.

alter table trackside_passes drop constraint trackside_passes_track_check;
alter table trackside_passes alter column track drop not null;
alter table trackside_passes add column track_index smallint;
