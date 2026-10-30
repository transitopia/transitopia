-- A bike route's ferry crossings (packages/cycling-core/README.md#bike-routes): in length_m, not
-- in comfort_m. Routes loaded before this are replaced by the next build's.
alter table cycling_routes add column ferry_m integer not null default 0;
