# Kootenays (BC Transit)

BC Transit's systems in the West Kootenay (Nelson, Castlegar, Trail, Rossland and Nakusp) and the Creston Valley (feed `bc-transit-kootenays`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 2 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "West Kootenay" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 36, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 5 minutes while buses run: small systems, where frequent polling isn't needed), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| West Kootenay | 20 | 1, 2, 2R, 3, 4, 10, 10X, 14, 15, 20, 31, 32, 33, 34, 36, 38, 41, 42, 43, 43X, 44, 45, 46, 51, 52, 53, 57, 58, 72, 74, 76, 98, 99 |
| Creston Valley | 16 | 51, 52, 54 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=20,16`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1, and 2 numbers (51, 52) are used by more than one, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-NAN` and `1-COM` are two routes, both shown as "1".
- **Not in it yet**: the East Kootenay (export 21: Cranbrook, Kimberley, the Columbia Valley and the Elk Valley), whose exports are in `America/Edmonton`, an hour ahead of the rest of BC all year. A feed has one time zone, and plans and the server still compute every service day in `America/Vancouver` (`build-schedule` refuses another), so these systems wait for per-feed time zones.
- **Static timetable**: 836 trips on 2026-11-02, each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
