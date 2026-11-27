# Northern BC (BC Transit)

BC Transit's systems in Prince George and the Bulkley-Nechako, Smithers, Terrace, Kitimat and the Hazeltons, and Prince Rupert and Port Edward (feed `bc-transit-northern-bc`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 4 exports, one per system, merged into one feed. Dawson Creek and Fort St. John, in another time zone, are the [Peace Region](../bc-transit-peace/README.md) feed. The map shows it wherever it's in view; the site's "Prince George" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 48, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 2 minutes while buses run, the most for BC Transit systems other than Victoria and Kelowna), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| Prince George and Bulkley-Nechako | 22 | 1, 5, 10, 11, 12, 15, 16, 19, 46, 47, 55, 88, 89, 91, 96, 97, 161, 162 |
| Terrace, Kitimat and the Hazeltons | 26 | 1A, 1B, 2, 3, 4, 11, 12, 13, 14, 31, 32, 41, 42, 43, 44, 45, 46, 99, 163, 164 |
| Smithers | 31 | 22, 23 |
| Prince Rupert and Port Edward | 23 | 51, 52, 53, 54, 55, 57, 60, 99 |

## What we know

- **One feed from several exports**: BC Transit's static export takes one system at a time; asked for several (`?operatorIds=22,26,31,23`, in any spelling) it returns an empty feed, while its GTFS-realtime returns every system's buses (checked 2026-11-02). So `fetch-gtfs` fetches each export and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)). Their route, trip, shape and block ids never clash, a service listed by two has the same dates in both, and the stops two neighbouring systems share differ by a few metres or a name: the first export's is kept.
- **Route keys**: Its systems each number their routes from 1, and 6 numbers (1, 11, 12, 46, 55, 99) are used by more than one, so its routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-PRG` and `1-TSK` are two routes, both shown as "1".
- **Time zones** (was OPEN-QUESTIONS #7): Dawson Creek's and Fort St. John's exports (27, 28) are in `America/Dawson_Creek`, the Peace region's year-round Mountain Standard Time, the others in `America/Vancouver`. They were in this feed with their zone taken as Vancouver's, which holds only while the two have the same offset (as they have since tzdata 2026b). With per-feed time zones (issue #261) they're a feed of their own in their own zone, [Peace Region](../bc-transit-peace/README.md) (2026-11-27), and a feed's exports must all be in its zone.
- **Static timetable**: 5,732 trips on 2026-11-02 (with Dawson Creek and Fort St. John), each export regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
