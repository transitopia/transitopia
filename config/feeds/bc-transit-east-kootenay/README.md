# East Kootenay (BC Transit)

BC Transit's East Kootenay system: Cranbrook, Kimberley, the Columbia Valley (Invermere) and the Elk Valley (Fernie, Sparwood, Elkford) (feed `bc-transit-east-kootenay`, [docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)): one export. The map shows it wherever it's in view; the site's "Cranbrook" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: its GTFS and GTFS-realtime, request budget, time zone and its checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions (none yet) |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: all 13 (export 21: 1, 2, 3, 4, 5, 7, 14, 22, 23, 31, 32, 33, 41), each coloured by frequency. Buses are live from BC Transit's GTFS-realtime where the server polls it (every 5 minutes while buses run, as for the West Kootenay: small systems, where frequent polling isn't needed), estimated from the timetable otherwise.

## What we know

- **Time zone**: its export's `agency_timezone` is `America/Edmonton` (checked 2026-11-27): the East Kootenay keeps Mountain Time, as Alberta does, an hour ahead of the rest of BC all year (Alberta stayed on UTC−6 from 2026-11-01; tzdata 2026e). That's why it's a feed of its own rather than part of the [Kootenays](../bc-transit-kootenays/README.md) feed, whose West Kootenay and Creston are in `America/Vancouver`: GTFS gives a feed one zone ([packages/transit-map → Time zones](../../../packages/transit-map/README.md#time-zones)).
- **Route keys**: its route numbers are unique within the export, so routes are keyed by number, as in single-system feeds.
- **Static timetable**: 519 trips in the export of 2026-11-27 (valid to 2027-06-27), regenerated daily under a new `feed_version`, like the other BC Transit feeds ([Central Okanagan → Static timetable](../bc-transit-kelowna/README.md#static-timetable)).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
