# Central Okanagan

A bus-only region, added to keep Transitopia multi-region and multi-agency before a second big city ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)). It shows BC Transit's Kelowna Regional Transit System (feed `bc-transit-kelowna`, [config/feeds/bc-transit-kelowna/](../../feeds/bc-transit-kelowna/)).

| Path | What |
|---|---|
| `region.json` | bbox (Peachland to Lake Country), time zone, the first view of `/transit`, time zone data checks, and its feed |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: every route in the feed, with the **97 Okanagan RapidBus** (Westbank Exchange to UBCO Exchange by Boucherie Mountain and Queensway exchanges) as frequent (`config/feeds/bc-transit-kelowna/routes.json`) and the rest as regular. Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

## What we know

- **Real-time data** (sampled 2026-10-14 15:00): 52 buses reporting, 9 of them on the 97; trip updates covered 90 % of buses on a trip.

### Buses

*Was part of OPEN-QUESTIONS #4.* Kelowna has no articulated buses (Braden MacDonald, 2026-10-15), so the 97 is drawn as a 12 m bus.

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
