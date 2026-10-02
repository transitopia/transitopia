# @transitopia/transit-core

The DOM-free transit engine, shared by the pipelines, the server, tests and the browser (its tsconfig has no DOM lib, and it must stay that way). The design is in [DESIGN.md](DESIGN.md).

| Folder | What | Design |
|---|---|---|
| `src/gtfs/`, `src/plan/`, `src/time.ts` | Service-day calendars, the service plan format and feed selection, bus stops, route coverage, SeaBus berths, time zones | [Timetables](DESIGN.md#timetables) |
| `src/infra/` | The track model, topology from OSM, platform mapping, switch-aware routing | [Track graph](DESIGN.md#track-graph) |
| `src/movement/` | Run inference, kinematics, movement files, and pure playback | [Run inference](DESIGN.md#run-inference), [Movements and playback](DESIGN.md#movements-and-playback) |
| `src/schedule/` | The schedule engine for timetable vehicles (SeaBus, WCE, buses), with re-timing and corrections | [SeaBus and West Coast Express](DESIGN.md#seabus-and-west-coast-express) |
| `src/dispatch/` | The signalling-aware dispatcher and dispatch patches | [Dispatcher](DESIGN.md#dispatcher) |
| `src/corrections/` | Observations: types, validation, and how they become dispatcher inputs or schedule corrections | [Corrections](DESIGN.md#corrections) |
| `src/disruption/` | Disruptions: types, drafting from TransLink alerts, applying them to a date | [Disruptions and alerts](DESIGN.md#disruptions-and-alerts) |
| `src/rt/` | Bus real-time data: snapshots, the request budget, prediction profiles, delay carry-forward, service changes, observed stop times, daily statistics | [Buses](DESIGN.md#buses), [docs/DESIGN.md → Retention and statistics](../../docs/DESIGN.md#retention-and-statistics) |
| `src/ais/` | SeaBus AIS: fixes, matching to the timetable, smoothing | [SeaBus AIS](DESIGN.md#seabus-ais) |
| `src/scenario/` | Scenario infrastructure and service operations | [Scenarios](DESIGN.md#scenarios) |

Import modules by path from other workspaces, e.g. `@transitopia/transit-core/infra/graph.ts`. Tests: `npm test` (vitest, `test/`).
