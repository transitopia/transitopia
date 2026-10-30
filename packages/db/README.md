# @transitopia/db

PostgreSQL (18, with PostGIS) for the Transitopia server: SQL migrations, [Kysely](https://kysely.dev) types, partitions and jobs. What lives in the database, and for how long, is in [docs/DESIGN.md → Where data lives](../../docs/DESIGN.md#where-data-lives).

| File | What |
|---|---|
| `migrations/NNN_<name>.sql` | Plain SQL, applied in order by the server when it starts (`src/migrate.ts`), each once, recorded in `schema_migrations` by name. Add a new file for every change; never edit one that's deployed. |
| `src/schema.ts` | Kysely types for every table: update them with each migration |
| `src/connect.ts` | `createDb(url)`: a pool and a Kysely instance |
| `src/partitions.ts` | Daily partitions (UTC) for raw tables, monthly ones for observed stop times; dropping expired daily partitions is how raw data expires |
| `src/jobs.ts` | `job_runs`: run a job once per key, retry failures, reset runs interrupted by a restart |
| `src/storage.ts` | Database and per-table sizes (partitions summed), reported at `/admin/api/status` → `storage` |
| `src/testing.ts` | A scratch database per test file, when `TEST_DATABASE_URL` is set (tests are skipped otherwise) |

## Tables

| Table | What | Kept |
|---|---|---|
| `regions`, `operators`, `feeds` | Region, operator and feed records, upserted from `config/regions/*/region.json`, `config/operators/*/operator.json` and `config/feeds/*/feed.json` when the server starts (a feed references its operator) ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)). What comes from a feed is keyed by `feed_id` (polls, positions, trip changes, alerts, GTFS feeds, observed stop times, statistics); AIS fixes too; corrections and dispatch versions by `region_id`. | |
| `service_leader` | Where followers forward `/rt/*`. Leadership itself is a session advisory lock. | |
| `upstream_requests` | Every upstream request, successful or not, by `provider` (the feed id): each feed's daily cap is enforced against it, so restarts and retries count | |
| `rt_polls` | One row per poll or AIS batch: the coverage record | |
| `rt_positions` | Raw vehicle positions from every poll, for every route (partitioned by day) | 60 days |
| `ais_fixes` | Raw AIS fixes of a feed's vessels (the SeaBus), by `feed_id` (partitioned by day) | 60 days |
| `trip_changes` | Trips a feed reported cancelled or skipping stops, per service date, every route | indefinitely |
| `alerts` | GTFS-RT alerts with first and last sighting; the latest wording wins | indefinitely |
| `observation_sets`, `disruptions` | Curated corrections: `body` is the file format, `state` the review state (`draft`, `previewing`, `confirmed`, `discarded`). Only confirmed ones apply. | indefinitely |
| `dispatch_versions` | Dispatch patch versions (the patches are files): `live` or `preview` | indefinitely |
| `gtfs_feeds` | GTFS static feeds (the zips are in the archive bucket). `seq` numbers them in the order they were archived, which ranges of refs are over; `reconciled_at` is when feature reconciliation took the version in. | indefinitely |
| `features` | The feature registry ([docs/DESIGN.md → Feature IDs](../../docs/DESIGN.md#feature-ids)): an ID per station, exchange, stop, route and bike route; its kind, operator and feed, name, position (`geom`, a PostGIS geography point; null for routes, vehicles and bike routes, whose extent is in `cycling_routes`), status (`active`, `retired`, `merged` with `merged_into`), and a stop's station or exchange (`parent_id`) | indefinitely |
| `feature_refs` | The source records a feature is (`scheme`, `namespace`, `ref`), over a range of feed versions (`versions`, an `int4range` of `gtfs_feeds.seq`; unbounded for schemes without versions). An exclusion constraint (`btree_gist`) keeps a ref to one feature in each version. | indefinitely |
| `feature_flags` | What reconciliation wasn't sure of (`reason`, `candidates`), for an admin to resolve | indefinitely |
| `feature_changes` | Every admin change to the registry (`set-parent`, `retire`, …), with before and after | indefinitely |
| `cycling_builds`, `cycling_routes`, `cycling_route_members` | Each area's bike routes from its latest cycling build (name, ref, network, length, length by comfort, ferry crossings, bbox) and which contain which, in member order, replaced by the next build ([apps/server → Cycling routes](../../apps/server/README.md#cycling-routes)). Their IDs are in `features` (`cycling-route`, ref `osm-relation:<id>`). | the latest build |
| `observed_stop_times` | Per trip and stop, when the vehicle was there, derived from raw positions while they exist: the atom behind every statistic (partitioned by month). `feed_version` is the GTFS version it was derived from; `observed_stop_times_by_feature` adds each row's stop feature. | indefinitely |
| `route_stats_daily` | Per-route statistics per service date and time band; `coverage` is the share of scheduled trip time the recorder covered, so a gap is a gap, never a zero. `feed_version` as above; `route_stats_daily_by_feature` adds each row's route feature, continuous across feed versions. | indefinitely |
| `job_runs` | Scheduled and catch-up jobs, one row per job and key | |
| `users`, `sessions` | Admins signed in with GitHub; sessions store only the token's SHA-256 | |

Locally: `npm run db:up` starts PostgreSQL on port 5433 (`infra/compose.dev.yml`). Tests: `TEST_DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/postgres npm test`.
