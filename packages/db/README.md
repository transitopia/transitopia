# @transitopia/db

PostgreSQL (18, with PostGIS) for the Transitopia server: SQL migrations, [Kysely](https://kysely.dev) types, partitions and jobs. What lives in the database, and for how long, is in [docs/DESIGN.md → Where data lives](../../docs/DESIGN.md#where-data-lives).

| File | What |
|---|---|
| `migrations/NNN_<name>.sql` | Plain SQL, applied in order by the server when it starts (`src/migrate.ts`), each once, recorded in `schema_migrations` by name. Add a new file for every change; never edit one that's deployed. |
| `src/schema.ts` | Kysely types for every table: update them with each migration |
| `src/connect.ts` | `createDb(url)`: a pool and a Kysely instance |
| `src/partitions.ts` | Daily partitions (UTC) for raw tables, monthly ones for observed stop times; dropping expired daily partitions is how raw data expires |
| `src/jobs.ts` | `job_runs`: run a job once per key, retry failures, reset runs interrupted by a restart |
| `src/testing.ts` | A scratch database per test file, when `TEST_DATABASE_URL` is set (tests are skipped otherwise) |

## Tables

| Table | What | Kept |
|---|---|---|
| `regions` | Region records | |
| `service_leader` | Where followers forward `/rt/*`. Leadership itself is a session advisory lock. | |
| `upstream_requests` | Every upstream request, successful or not: the daily cap is enforced against it, so restarts and retries count | |
| `rt_polls` | One row per poll or AIS batch: the coverage record | |
| `rt_positions` | Raw vehicle positions from every poll, for every route (partitioned by day) | 60 days |
| `ais_fixes` | Raw SeaBus AIS fixes (partitioned by day) | 60 days |
| `trip_changes` | Trips TransLink reported cancelled or skipping stops, per service date, every route | indefinitely |
| `alerts` | GTFS-RT alerts with first and last sighting; the latest wording wins | indefinitely |
| `observation_sets`, `disruptions` | Curated corrections: `body` is the file format, `state` the review state (`draft`, `previewing`, `confirmed`, `discarded`). Only confirmed ones apply. | indefinitely |
| `dispatch_versions` | Dispatch patch versions (the patches are files): `live` or `preview` | indefinitely |
| `gtfs_feeds` | GTFS static feeds (the zips are in the archive bucket) | indefinitely |
| `observed_stop_times` | Per trip and stop, when the vehicle was there, derived from raw positions while they exist: the atom behind every statistic (partitioned by month) | indefinitely |
| `route_stats_daily` | Per-route statistics per service date and time band; `coverage` is the share of scheduled trip time the recorder covered, so a gap is a gap, never a zero | indefinitely |
| `job_runs` | Scheduled and catch-up jobs, one row per job and key | |
| `users`, `sessions` | Admins signed in with GitHub; sessions store only the token's SHA-256 | |

Locally: `npm run db:up` starts PostgreSQL on port 5433 (`infra/compose.dev.yml`). Tests: `TEST_DATABASE_URL=postgres://transitopia:transitopia@localhost:5433/postgres npm test`.
