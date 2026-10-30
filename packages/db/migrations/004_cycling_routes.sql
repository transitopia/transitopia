-- Bike routes (packages/cycling-core/README.md#bike-routes): each cycling build's OSM bike route
-- relations, which the server loads after the data build, replacing the area's previous ones, and
-- how they nest. Their IDs (`cr`) are in the feature registry, by ref (`osm-relation:<id>`).

-- The build each area's routes are from.
create table cycling_builds (
  area text primary key,
  osm_file text not null,          -- data/osm/<area>/<file>
  osm_timestamp timestamptz not null,
  built_at timestamptz not null,
  loaded_at timestamptz not null default now()
);

create table cycling_routes (
  area text not null references cycling_builds on delete cascade,
  relation_id bigint not null,
  name text,
  ref text,
  network text,                    -- OSM's: lcn, rcn, ncn, icn
  -- Of its ways and its subroutes' in the area, each once; by comfort 0 (no bike facility) to 4.
  length_m integer not null,
  comfort_m integer[] not null check (cardinality(comfort_m) = 5),
  -- [west, south, east, north]; null when none of its ways are in the area.
  bbox double precision[] check (bbox is null or cardinality(bbox) = 4),
  primary key (area, relation_id)
);
create index on cycling_routes (relation_id);

-- A route's subroutes (OSM relation members that are bike routes), in member order. A route can
-- be in several.
create table cycling_route_members (
  area text not null,
  parent bigint not null,
  child bigint not null,
  position integer not null,
  primary key (area, parent, child),
  foreign key (area, parent) references cycling_routes on delete cascade,
  foreign key (area, child) references cycling_routes on delete cascade
);
create index on cycling_route_members (area, child);
