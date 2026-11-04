# Thompson–Cariboo (BC Transit)

BC Transit's systems in Kamloops, Merritt and Clearwater, and up the Cariboo through Ashcroft, Cache Creek and Clinton, 100 Mile House and Williams Lake to Quesnel (feed `bc-transit-thompson-cariboo`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 7 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "Kamloops" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 49, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 2 minutes while buses run, the most for BC Transit systems other than Victoria and Kelowna), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| Kamloops | 46 | 1, 2, 3, 4, 5, 6, 7, 9, 10, 13, 14, 16, 17, 18, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81 |
| Merritt | 37 | 1, 2, 3, 4 |
| Clearwater | 35 | 1, 2, 3, 10 |
| Ashcroft-Cache Creek-Clinton | 38 | 1 |
| 100 Mile House | 34 | 1, 2 |
| Williams Lake | 33 | 1, 2, 3, 4 |
| Quesnel | 32 | 1, 1R, 2, 2A, 2B, 3, 30, 31 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=46,37,35,38,34,33,32`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1, and 5 numbers (1, 2, 3, 4, 10) are used by more than one, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-NAN` and `1-COM` are two routes, both shown as "1".
- **Static timetable**: 3,099 trips on 2026-11-02, each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
