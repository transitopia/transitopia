# Okanagan–Shuswap (BC Transit)

BC Transit's systems in the North Okanagan (Vernon and the Shuswap), the South Okanagan and Similkameen (Penticton to Osoyoos and Princeton) and Revelstoke; Central Okanagan (Kelowna) is its own feed, `bc-transit-kelowna` (feed `bc-transit-okanagan-shuswap`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 3 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "Vernon" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 40, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 2 minutes while buses run, the most for BC Transit systems other than Victoria and Kelowna), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| North Okanagan (Vernon and the Shuswap) | 14 | 1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 22, 23, 24, 25, 41, 42, 43, 60, 61, 90 |
| South Okanagan-Similkameen | 15 | PL, 1, 2, 3, 4, 5, 10, 11, 15, 16, 20, 21, 30, 40, 41, 50, 70 |
| Revelstoke | 36 | 1, 3, 5 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=14,15,36`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1, and 7 numbers (1, 2, 3, 4, 5, 21, 41) are used by more than one, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-NAN` and `1-COM` are two routes, both shown as "1".
- **Static timetable**: 2,707 trips on 2026-11-02, each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
