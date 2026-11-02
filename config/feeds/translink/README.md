# TransLink

What we've learned about how TransLink's SeaBus runs, and where it came from (the SkyTrain's track and operations are the rail network's: [config/networks/skytrain/](../../networks/skytrain/README.md)). Questions still open are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); when one is answered, update the config, move the answer here with its source, and leave a pointer in its place.

| Path | What |
|---|---|
| `feed.json`, `routes.json` | The feed: GTFS and GTFS-RT, request budget, AIS, time zone checks; overrides of the routes drawn ([docs/DESIGN.md → Feeds, operators and rail networks](../../../docs/DESIGN.md#feeds-operators-and-rail-networks)) |
| `ferries/seabus.json` | SeaBus: the berths and crossing lanes drawn instead of the GTFS shapes, and the default berth pair |
| `observations/` | Observations in the file format ([README](observations/README.md)), with GPS tracks in `observations/gpx/`: imported into a new database, and read by local pipeline runs (`npm run data`) |

## SeaBus

### Vessels and service

*Was OPEN-QUESTIONS #14.* Two vessels normally, three at weekday peaks (Braden, 2026-09-28), confirmed against GTFS feed `26SEP_20260925`. Every crossing is 12 minutes, with 2–4 minute layovers. GTFS blocks follow one vessel each: every trip in a block starts where the last one ended.

- **Weekdays** (4 blocks, at most 3 at once): 15-minute service with 2 vessels from 06:02; 10-minute service with 3 vessels 07:10–09:47 and 15:10–18:47 (Lonsdale Quay departures every 10 minutes 07:00–09:30 and 15:00–18:30, Waterfront 07:15–09:35 and 15:15–18:45); 15-minute service with 2 vessels in between and until 21:13; then 30-minute service with 1 vessel until 01:34. One vessel runs 05:47–06:02. The AM (05:47–09:47) and PM (15:10–21:13) peak extras are separate blocks; whether they're the same vessel isn't in the data.
- **Saturday:** 1 vessel 06:02–07:17 (30 minutes), 2 until 21:13 (15 minutes), then 1 until 01:34. **Sunday and holidays:** 1 vessel 08:02–08:17, 2 until 21:14, then 1 until 23:34.

Only vessels in service are shown: a vessel is drawn from its block's first departure to its last arrival and waits at the dock between crossings. Spares and the Lonsdale maintenance berth are hidden.

### Berths and lanes

*Was OPEN-QUESTIONS #24.*

- Waterfront and Lonsdale Quay each have two berths. On 2026-09-26 the Burrard Pacific Breeze used the West berth at Waterfront at 14:15 and the western berth at Lonsdale Quay at 14:29 (Braden).
- On a given day every vessel runs west berth to west berth, or every vessel east to east, with rare exceptions: the wheelhouse sees the ramps better from one side (Braden, 2026-09-28). The timetable allows one berth per terminal even at the weekday peak (a vessel leaves at least 7 minutes before the next arrives).
- Vessels keep right, so the two directions cross on either side of the direct line, up to ~250 m apart (AIS tracks, Braden, 2026-09-28).
- Which pair is in use on a given day comes from AIS: where the day's vessels dock ([packages/transit-core/DESIGN.md → SeaBus AIS](../../../packages/transit-core/DESIGN.md#seabus-ais)). The default is west–west (`defaultPair`, from the 2026-09-26 sighting) until a day's docked fixes say otherwise. 2026-09-28 evening: west–west.
- Berth positions were read off the basemap's pier outlines and checked by Braden (2026-09-28). Modelled in `ferries/seabus.json` (berths, lanes traced from AIS) and `seabus.json` (pairing), applied at plan build time instead of the GTFS shapes.
