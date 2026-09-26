# Observations

Ground-truth corrections to the schedule-inferred SkyTrain trains (PLAN.md §4.7). Put JSON files here, e.g. `2026-09-28-rider-reports.json`, then run `npm run build:observations` (it also runs as part of `npm run data`). The app applies them on the matching service dates.

```json
{
  "observations": [
    { "kind": "at_platform", "date": "2026-09-28", "stop": "Commercial-Broadway", "line": "expo",
      "time": "2026-09-28T08:15:30-07:00", "source": "rider report",
      "consist": { "type": "Mk III", "cars": 4, "carNumbers": ["301", "302", "303", "304"] } },
    { "kind": "delay",   "date": "2026-09-28", "trip": "15522403", "seconds": 180, "source": "TransLink alert" },
    { "kind": "cancel",  "date": "2026-09-28", "trip": "15522410", "source": "TransLink alert" },
    { "kind": "consist", "date": "2026-09-28", "trip": "15522403", "consist": { "type": "Mk I", "cars": 6 }, "source": "photo" }
  ]
}
```

- `date` is the **service date** (after-midnight trips belong to the previous day).
- Identify trains by **GTFS trip_id** or by **stop + time** (`at_platform` without `trip` matches the train scheduled at that stop within ±10 min). Never use inferred run ids like `expo-012`: they change when runs are rebuilt.
- `stop` can be a GTFS stop_id, a stop name ("Waterfront Station @ Platform 1"), or a station name ("Waterfront").
- `time` is ISO 8601 with a UTC offset.
- Every observation needs a `source`. The app shows it, and marks positions within 90 s of an observation as *observed* and delay-shifted positions as *interpolated*.

Effects: a delay shifts the train's run from that point and is absorbed by later terminus layovers (keeping a 60 s turnaround). A cancelled trip hides the train during that trip. A consist applies to the whole inferred run.
