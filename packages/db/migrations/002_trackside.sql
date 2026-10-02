-- Trackside cameras (packages/trackside/README.md): trains seen passing a camera beside the guideway.
-- A device sends only these reports (no video), plus small crops of the car numbers it read, which
-- are kept to check and improve the reader.

create table trackside_passes (
  -- Made by the device, so a retried upload isn't stored twice.
  id text primary key,
  region_id text not null references regions,
  -- One camera session (CameraSetup.id); `report` holds the whole setup.
  setup_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  track text not null check (track in ('near', 'far')),
  -- Compass bearing of travel, and the approximate speed from the camera's geometry.
  bearing real not null,
  speed_kmh real,
  -- Car numbers read, front first.
  cars text[] not null,
  -- The PassReport as sent, without the crops.
  report jsonb not null,
  created_by text,
  received_at timestamptz not null default now()
);
create index on trackside_passes (region_id, started_at);

create table trackside_crops (
  pass_id text not null references trackside_passes on delete cascade,
  idx integer not null,
  -- What the reader made of it, and whether it was confident enough to report it as a car.
  reading text not null,
  confidence real not null,
  accepted boolean not null,
  jpeg bytea not null,
  -- The true number, when a person has checked it.
  label text,
  primary key (pass_id, idx)
);
