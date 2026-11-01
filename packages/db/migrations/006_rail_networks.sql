-- Rail networks (docs/DESIGN.md#feeds-operators-and-rail-networks): disruptions and dispatch
-- versions are a rail network's (they name its track), observations a feed's (service date + GTFS
-- trip_id), and nothing is a region's any more. Every row so far is Metro Vancouver's, which shows
-- TransLink's feed on the SkyTrain network.

create table rail_networks (
  id text primary key,
  name text not null,
  timezone text not null
);
-- The server upserts every network (config/networks/*/network.json) when it starts.
insert into rail_networks (id, name, timezone)
values ('skytrain', 'SkyTrain', 'America/Vancouver');

alter table observation_sets add column feed_id text not null default 'translink' references feeds;
alter table observation_sets alter column feed_id drop default;
alter table observation_sets drop column region_id;

alter table disruptions add column network_id text not null default 'skytrain' references rail_networks;
alter table disruptions alter column network_id drop default;
alter table disruptions drop column region_id;

alter table dispatch_versions add column network_id text not null default 'skytrain' references rail_networks;
alter table dispatch_versions alter column network_id drop default;
alter table dispatch_versions drop constraint dispatch_versions_pkey;
alter table dispatch_versions add primary key (network_id, service_date, version);
alter table dispatch_versions drop column region_id;

-- One leader per deployment (apps/server/README.md#leader), whatever it serves: the table has at
-- most one row. The leader writes it again when it next takes the lock.
drop table service_leader;
create table service_leader (
  singleton boolean primary key default true check (singleton),
  instance text not null,
  url text,
  pid integer,
  started_at timestamptz not null,
  heartbeat_at timestamptz not null
);

drop table regions;
