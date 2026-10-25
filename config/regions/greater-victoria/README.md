# Greater Victoria

A bus-only region, added to keep Transitopia multi-region and multi-agency before a second big city ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)). It shows BC Transit's Victoria Regional Transit System (feed `bc-transit-victoria`, [config/feeds/bc-transit-victoria/](../../feeds/bc-transit-victoria/)).

| Path | What |
|---|---|
| `region.json` | bbox (Sooke to Swartz Bay), time zone, the first view of `/transit`, time zone data checks, and its feed |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: every route in the feed, with **95 Langford / Downtown Blink** as frequent (RapidBus; `config/feeds/bc-transit-victoria/routes.json`) and the rest as regular. Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

## What we know

- **Exchanges**: the drawn routes use Legislature, Langford, Colwood, UVic, Royal Oak and McTavish exchanges and Swartz Bay Ferry Terminal. BC Transit names bays without `@` ("Langford Exch (Jacklin Rd) Bay D"); a group of bays on a side street is the same exchange (feed of 2026-10-14).
- **Real-time data** (sampled 2026-10-14 15:00): 185 buses reporting, every one on a trip; trip updates covered 85 % of them; 33 trips marked `CANCELED`. Fixes were p50 ~8 s old when fetched.

### Static timetable

*Was part of OPEN-QUESTIONS #1.* BC Transit exports the static feed every day under a new `feed_version`, and each export is the previous one minus the date that has passed: its `calendar_dates.txt` rows, and the trips (with their stop times) of services that ran only then; `feed_start_date` moves forward and `feed_end_date` stays. Every other file is byte-identical. Seen in every export from 2026-10-14 to 10-25, compared with the one before (`rolloffDifference` in `packages/data/src/gtfs-rolloff.ts`), whose timetable never otherwise changed. So `fetch-gtfs` keeps the newest archived version for such an export, instead of archiving about 16 MB and building a plan every day.

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
