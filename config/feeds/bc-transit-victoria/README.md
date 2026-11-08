# Greater Victoria (BC Transit)

BC Transit's Victoria Regional Transit System, Sooke to Swartz Bay (feed `bc-transit-victoria`), added to keep Transitopia multi-feed and multi-agency before a second big city ([docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)). The map shows it wherever it's in view; the site's "Greater Victoria" view (`apps/web/src/TransitMap/views.ts`) goes there.

| Path | What |
|---|---|
| `feed.json` | The feed: its GTFS and GTFS-realtime, request budget, time zone checks; its operator (`config/operators/bc-transit/`) |
| `routes.json` | Its overrides: brand colours and exclusions |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: every route in the feed, with **95 Langford / Downtown Blink** as frequent (RapidBus; `config/feeds/bc-transit-victoria/routes.json`) and the rest as regular. Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

## What we know

- **Exchanges**: the drawn routes use Legislature, Langford, Colwood, UVic, Royal Oak and McTavish exchanges and Swartz Bay Ferry Terminal. BC Transit names bays without `@` ("Langford Exch (Jacklin Rd) Bay D"); a group of bays on a side street is the same exchange (feed of 2026-10-14).
- **Real-time data** (sampled 2026-10-14 15:00): 185 buses reporting, every one on a trip; trip updates covered 85 % of them; 33 trips marked `CANCELED`. Fixes were p50 ~8 s old when fetched.
- **Trips not in the timetable** (2026-10-15 and 11-04): some buses report trips no static feed has, with ids starting `1230…` (e.g. `12307439:14539558:14592516`), on real routes, often with a transit centre (`900001` Victoria, `930002` Langford) as the next stop and no trip update: runs to and from the depot. On 2026-11-04, 24 trips, 23 buses and 4 % of fixes. They aren't drawn (issue #184).

### Static timetable

*Was part of OPEN-QUESTIONS #1.* BC Transit exports the static feed every day under a new `feed_version`, and each export is the previous one minus the date that has passed: its `calendar_dates.txt` rows, and the trips (with their stop times) of services that ran only then; `feed_start_date` moves forward and `feed_end_date` stays. Every other file is byte-identical. Seen in every export from 2026-10-14 to 10-25, compared with the one before (`rolloffDifference` in `packages/data/src/gtfs-rolloff.ts`), whose timetable never otherwise changed. So `fetch-gtfs` keeps the newest archived version for such an export, instead of archiving about 16 MB and building a plan every day.

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
