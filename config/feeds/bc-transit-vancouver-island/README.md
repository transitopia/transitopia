# Vancouver Island (BC Transit)

BC Transit's systems in from the Cowichan Valley to Port Hardy, every BC Transit system on Vancouver Island but Greater Victoria's (feed `bc-transit-victoria`), and Salt Spring Island (feed `bc-transit-vancouver-island`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 8 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "Nanaimo" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 79, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 2 minutes while buses run, the most for BC Transit systems other than Victoria and Kelowna), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| Nanaimo | 41 | 1, 5, 6, 7, 8, 9, 15, 15A, 20, 20A, 25, 30, 31, 40, 70, 72, 78, 88, 92, 97, 98, 99 |
| Cowichan Valley | 10 | 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 31, 34, 36, 66, 99 |
| Comox Valley | 45 | 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 20, 99 |
| Campbell River | 12 | 1, 2, 3, 4, 6, 7, 8, 15 |
| Port Alberni | 11 | 1, 2, 3, 4 |
| West Coast | 51 | 1 |
| Mount Waddington | 17 | 1, 2, 4, 5, 11, 12 |
| Salt Spring Island | 39 | 1, 2, 3, 4, 5, 6, 7 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=41,10,45,12,11,51,17,39`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1, and 15 numbers (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 15, 20, 31, 99) are used by more than one, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-NAN` and `1-COM` are two routes, both shown as "1".
- **Static timetable**: 3,473 trips on 2026-11-02, each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
