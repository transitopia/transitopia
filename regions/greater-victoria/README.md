# Greater Victoria

A bus-only region, added to keep Transitopia multi-region and multi-agency before a second big city ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)). It shows BC Transit's Victoria Regional Transit System (feed `bc-transit-victoria`, [feeds/bc-transit-victoria/](../../feeds/bc-transit-victoria/)).

| Path | What |
|---|---|
| `region.json` | bbox (Sooke to Swartz Bay), time zone, the first view of `/transit`, time zone data checks, and its feed |
| `config/` | Kinematics (buses only) and real-time use (prediction, carry), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes (`feeds/bc-transit-victoria/routes.json`): **95 Langford / Downtown Blink** (RapidBus, frequent), **15 Esquimalt / UVic** and **70 Swartz Bay / Downtown** (regular). Every other route in the feed is listed on cards (the route catalogue). Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

## What we know

- **Exchanges**: the drawn routes use Legislature, Langford, Colwood, UVic, Royal Oak and McTavish exchanges and Swartz Bay Ferry Terminal. BC Transit names bays without `@` ("Langford Exch (Jacklin Rd) Bay D"); a group of bays on a side street is the same exchange (feed of 2026-10-14).
- **Real-time data** (sampled 2026-10-14 15:00): 185 buses reporting, every one on a trip; trip updates covered 85 % of them; 33 trips marked `CANCELED`. Fixes were p50 ~8 s old when fetched.

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
