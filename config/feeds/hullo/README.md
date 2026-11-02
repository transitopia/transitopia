# Hullo

Hullo's passenger ferry between Vancouver (Coal Harbour, beside Waterfront) and Nanaimo, shown in Metro Vancouver alongside TransLink ([docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)). Questions still open are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config, move the answer here with its source, and leave a pointer in its place.

| Path | What |
|---|---|
| `feed.json` | The feed: its GTFS, its vessels' AIS, time zone checks; its operator (`config/operators/hullo/`) |
| `routes.json` | Its two GTFS routes (one per direction) drawn as one route, `hullo`, in Hullo's colour, with its vessels' settings |
| `ferries/hullo.json` | The berths and crossing lane drawn instead of the GTFS shapes |

## The GTFS

As checked on 2026-11-01 (version `20261020115220`, 35 KB, `https://hullo.com/gtfs/gtfs-hullo.zip`):

- One agency (`HULLO`, `America/Vancouver`) and two stops, the Vancouver and Nanaimo terminals.
- Two routes, `NAN-VAN` "Nanaimo to Vancouver" and `VAN-NAN` "Vancouver to Nanaimo", both `route_type` 4 (ferry), with no `route_color`. `routes.json` matches both by name and draws them as one route (`mergedGtfsRouteIds`, [packages/transit-core/DESIGN.md → Routes](../../../packages/transit-core/DESIGN.md#routes)).
- Every service is dated in `calendar_dates.txt`, one `service_id` per date; there is no `calendar.txt`.
- 2,919 trips of 75–80 minutes with no `block_id`: which vessel runs which trip comes only from AIS matching. Off-season (November) one vessel runs, about three round trips a day.
- Each direction's shape has six points, cutting across Stanley Park and through First Narrows, so the plan draws `ferries/hullo.json`'s lane instead.

## Real time

No GTFS-realtime was found. The two vessels, *spuhéls* (MMSI 316052439) and *sthuqi'* (MMSI 316052438), broadcast AIS, which the server's leader streams on the same aisstream.io connection as the SeaBus's ([packages/transit-core/DESIGN.md → SeaBus AIS](../../../packages/transit-core/DESIGN.md#seabus-ais)). As for the SeaBus, fixes anchor the timetable rather than being drawn raw.

## Lane and berths

Traced from a screenshot of five crossings' AIS tracks (Braden, 2026-11-02): out of Nanaimo's harbour north-east past Protection Island, across the Strait of Georgia (where the tracks spread over about 2 km, the lane is their median, smoothed), through First Narrows under Lions Gate Bridge (mid-channel), along Burrard Inlet off Stanley Park and round Brockton Point into Coal Harbour. Georeferenced on the two terminals and Lions Gate Bridge (25 m/px, ±170 m at the control points). OPEN-QUESTIONS #1.
