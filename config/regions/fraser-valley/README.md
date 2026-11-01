# Fraser Valley

A bus-only region east of Metro Vancouver, from Aldergrove to Hope ([docs/DESIGN.md → Regions and feeds](../../../docs/DESIGN.md#regions-and-feeds)). It shows BC Transit's Fraser Valley export (feed `bc-transit-fraser-valley`, [config/feeds/bc-transit-fraser-valley/](../../feeds/bc-transit-fraser-valley/)), which holds four transit systems in one GTFS and one GTFS-realtime feed (operator 13): BC Transit's open data page lists Central Fraser Valley, Chilliwack, Agassiz-Harrison and Hope under that one export, as one agency, every `route_id` ending in `-CFV`.

| Path | What |
|---|---|
| `region.json` | bbox (just east of Aldergrove to Hope and Harrison Hot Springs), time zone, the first view of `/transit`, time zone data checks, and its feed |
| Settings | None of its own yet: vehicles and real-time use come from [config/defaults/](../../defaults/) and BC Transit's [operator.json](../../operators/bc-transit/operator.json), each with a source or "guess" and a cross-reference to [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) |

Drawn routes: every route in the feed (school specials 22, 24 and 26 included), each coloured by frequency. The 66 Fraser Valley Express isn't drawn in its own colour: a long route in a thick, bright line was too distracting (`config/feeds/bc-transit-fraser-valley/routes.json`). Buses are live from BC Transit's GTFS-realtime where the server polls it, estimated from the timetable otherwise.

| Routes | System |
|---|---|
| 1–26 | Abbotsford (Central Fraser Valley); the 21 runs to Aldergrove (272 St) |
| 31–39 | Mission (Central Fraser Valley) |
| 51–59 | Chilliwack |
| 66 | Fraser Valley Express: Chilliwack to Lougheed Station by Highway 1 |
| 71 | Agassiz-Harrison |
| 72 | Hope |

## Where it meets Metro Vancouver

TransLink and BC Transit both serve Mission City Station (West Coast Express, TransLink's 701; BC Transit's Mission routes) and Aldergrove (TransLink's 503; BC Transit's 21). Regions can't overlap and the site shows one at a time, so the bboxes meet at -122.45, just east of Aldergrove: Mission City Station, and all of Abbotsford, are in the Fraser Valley. Routes that cross the line are drawn only while their own region is shown: TransLink's WCE and 701 to Mission City Station, and its flag stops in Whonnock; BC Transit's 21 to Aldergrove and the 66 through Langley and Surrey to Lougheed Station. Fixing this is the multi-feed engine work (feeds loaded by viewport instead of one region at a time).

## What we know

- **Real-time data** (sampled 2026-11-01 10:00, a Sunday): 25 buses reporting, 6 of them on the 66; fixes were 1–26 s old when fetched. Positions ~4 KB, trip updates ~100 KB.
- **Static timetable**: exported daily under a new `feed_version` (`202611010/20261031 21:00:00/20261101 04:00:00`), like the other BC Transit feeds ([Central Okanagan → Static timetable](../central-okanagan/README.md#static-timetable)), so `fetch-gtfs` archives only a real timetable change. 2,320 trips, each with its own journey id (the first part of the trip id).

What's still assumed is in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config and move the answer here with its source.
