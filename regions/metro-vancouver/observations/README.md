# Observations

Ground-truth corrections to the schedule-inferred SkyTrain trains and to timetable vehicles (SeaBus, WCE, buses without real-time data) (PLAN.md §4.7). Put JSON files here, e.g. `2026-09-28-rider-reports.json`, then run `npm run build:observations && npm run build:dispatch` (both run as part of `npm run data`). SkyTrain observations are applied centrally by the dispatcher, which re-dispatches each observed date (`public/data/dispatch/<date>.json`); the app applies timetable-vehicle observations itself.

```json
{
  "observations": [
    { "kind": "at_platform", "date": "2026-09-28", "stop": "Commercial-Broadway", "line": "expo",
      "time": "2026-09-28T08:15:30-07:00", "source": "rider report",
      "consist": { "type": "Mk II", "cars": 4, "carNumbers": ["301", "302", "303", "304"] } },
    { "kind": "delay",   "date": "2026-09-28", "trip": "15522403", "seconds": 180, "source": "TransLink alert" },
    { "kind": "cancel",  "date": "2026-09-28", "trip": "15522410", "source": "TransLink alert" },
    { "kind": "consist", "date": "2026-09-28", "trip": "15522403", "consist": { "type": "Mk I", "cars": 6 }, "source": "photo" },
    { "kind": "parked",  "date": "2026-09-26", "at": [-123.1091718, 49.2792047], "time": "2026-09-26T13:56:00-07:00",
      "from": "2026-09-26T13:30:00-07:00", "until": "2026-09-26T14:30:00-07:00", "line": "expo",
      "consist": { "type": "Mk I", "carNumbers": ["125"] }, "source": "rider report" }
  ]
}
```

- `date` is the **service date** (after-midnight trips belong to the previous day).
- Identify trains by **GTFS trip_id** or by **stop + time** (`at_platform` without `trip` matches the train scheduled at that stop within ±10 min). Never use inferred run ids like `expo-012`: they change when runs are rebuilt.
- `stop` can be a GTFS stop_id, a stop name ("Waterfront Station @ Platform 1"), or a station name ("Waterfront").
- `time` is ISO 8601 with a UTC offset.
- `event` (`"arrive"` or `"depart"`, on `at_platform`) says what `time` marks. Leave it out for a sighting while stopped. Use it at termini, where one vehicle both arrives and departs.
- For SeaBus, WCE and buses, give `line` (e.g. `"seabus"`). A `consist` can carry a `name` (e.g. a SeaBus vessel), which applies to the vehicle's whole GTFS block.
- Every observation needs a `source`. The app shows it, and marks positions within 90 s of an observation as *observed* and delay-shifted positions as *interpolated*.

A `parked` observation places an out-of-service train on the track nearest `at` (a point on that track, e.g. a siding). It's shown from `from` to `until`, defaulting to ±15 min around `time`: *observed* within 90 s of the sighting, *interpolated* otherwise.

Effects on SkyTrain: sightings and delays become anchors. The dispatcher moves the anchored stop (an arrival keeps the hop's running time and spends the difference at the previous stop; a departure ends the dwell) and signalling carries the effect to the trains around it; later terminus layovers absorb delay. A cancelled trip hides the train during that trip. A consist applies to the whole inferred run. `build:dispatch` lists any observation it couldn't apply. For timetable vehicles, a sighting shifts that trip (with several sightings, the delay changes linearly between them, e.g. time made up crossing), and the wait at the terminal stretches until the next trip's corrected departure.
