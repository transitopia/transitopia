# Peace Region (BC Transit)

BC Transit's systems in Dawson Creek and Fort St. John (feed `bc-transit-peace`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): 2 exports, one per system, merged into one feed. The map shows it wherever it's in view; the site's "Fort St. John" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: the exports it merges, its GTFS-realtime, request budget, time zone and its checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 7, each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 5 minutes while buses run, as for the Kootenays: small systems, where frequent polling isn't needed), estimated from the timetable otherwise.

| System | Export (`operatorIds`) | Routes |
|---|---|---|
| Dawson Creek | 27 | 1, 2 |
| Fort St. John | 28 | 1, 2, 3, 4, 5 |

## What we know

- **Time zone**: both exports' `agency_timezone` is `America/Dawson_Creek` (checked 2026-11-27), the Peace region's Mountain Standard Time (UTC−7) all year. Since BC's permanent UTC−7 (tzdata 2026b) that has the same offset as `America/Vancouver`, and they were part of [Northern BC](../bc-transit-northern-bc/README.md) with their zone taken as Vancouver's. GTFS gives a feed one zone, so they're now a feed of their own in theirs, and their times stay right if the two zones ever differ ([packages/transit-map → Time zones](../../../packages/transit-map/README.md#time-zones)). Their stops kept their feature IDs: BC Transit's stop codes match across its feeds ([docs/DESIGN.md → Shared stops](../../../docs/DESIGN.md#shared-stops)); their routes got new ones, since routes match within a feed.
- **One feed from several exports**: as for Northern BC, BC Transit's static export takes one system at a time, so `fetch-gtfs` fetches each and merges them ([packages/transit-core/DESIGN.md → Timetables](../../../packages/transit-core/DESIGN.md#timetables)), while its GTFS-realtime takes both at once (`?operatorIds=27,28`).
- **Route keys**: both systems number their routes from 1 (1 and 2 are used by both), so routes are keyed by `route_id` (`feed.json` → `routeKey`; [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)): `1-DAW` and `1-FSJ` are two routes, both shown as "1".
- **Static timetable**: 418 trips in its two exports of 2026-11-27, regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
