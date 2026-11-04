# Sea to Sky (BC Transit)

BC Transit's systems in Squamish, Whistler and the Pemberton Valley (feed `bc-transit-sea-to-sky`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 3 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "Whistler" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 20 (2026-11-03), each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 5 minutes while buses run: small systems, where frequent polling isn't needed), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| Whistler | 44 | 4, 5, 6, 7, 10, 20, 20X, 21, 25, 30, 31, 32, 33 |
| Squamish | 43 | 1, 2, 3, 4, 9 |
| Pemberton Valley | 50 | 99, 100 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=44,43,50`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1. Whistler's winter routes (4 Marketplace Shuttle, 25, 33, in its export from 2026-11-03) brought a number Squamish also uses, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `4-WHI` and `4-SQU` are two routes, both shown as "4". Whistler and Pemberton share the `-WHI` suffix and number around each other.
- **Static timetable**: 1,166 trips on 2026-11-02, each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
