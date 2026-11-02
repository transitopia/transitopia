# Central Okanagan (BC Transit)

BC Transit's Kelowna Regional Transit System, Peachland to Lake Country (feed `bc-transit-kelowna`), added to keep Transitopia multi-feed and multi-agency before a second big city ([docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)). The map shows it wherever it's in view; the site's "Central Okanagan" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: its GTFS and GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: every route in the feed, with the **97 Okanagan RapidBus** (Westbank Exchange to UBCO Exchange by Boucherie Mountain and Queensway exchanges) as frequent (`config/feeds/bc-transit-kelowna/routes.json`) and the rest as regular. Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

## What we know

- **Real-time data** (sampled 2026-10-14 15:00): 52 buses reporting, 9 of them on the 97; trip updates covered 90 % of buses on a trip.

### Buses

*Was part of OPEN-QUESTIONS #4.* Kelowna has no articulated buses (Braden MacDonald, 2026-10-15), so the 97 is drawn as a 12 m bus.

### Static timetable

*Was part of OPEN-QUESTIONS #1.* BC Transit exports the static feed every day under a new `feed_version`, and each export is the previous one minus the date that has passed: its `calendar_dates.txt` rows (and the trips of services that ran only then); `feed_start_date` moves forward and `feed_end_date` stays. Every other file is byte-identical. Seen in every export from 2026-10-14 to 10-25, compared with the one before (`rolloffDifference` in `packages/data/src/gtfs-rolloff.ts`), whose timetable never otherwise changed. So `fetch-gtfs` keeps the newest archived version for such an export, instead of archiving and building a new one every day.

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
