# Scenarios

Alternate infrastructure and/or service, built with the same pipeline as the real network (docs/skytrain-viz-PLAN.md §4.8).

```sh
npm run scenario -- broadway-subway          # build
# then open http://localhost:5173/?scenario=broadway-subway
```

Each scenario is a directory containing `scenario.json`:

```jsonc
{
  "name": "Broadway Subway",
  "description": "…shown in the app",
  "infrastructure": {
    "includeFuture": true,               // OSM track with a future opening_date (regions/metro-vancouver/infrastructure/future.generated.geojson)
    "futureLines": ["millennium"],       // lines to assign to that track
    "customTrack": "custom-track.geojson", // extra track: LineStrings with {kind?, lines?, name?}
    "removeWays": []                     // OSM way ids to drop from the base network
  },
  "service": {
    "operations": [
      { "op": "extend", "route": "millennium", "at": "VCC-Clark",
        "stations": [{ "name": "Arbutus", "at": [-123.1527, 49.26385] }],
        "padding": 1.15, "dwell": 25 }
    ]
  }
}
```

Custom track tips (draw it in geojson.io or QGIS):
- **Joins:** a custom line joins existing track (or earlier custom lines) where its **endpoints** fall within 4 m of an existing track vertex. For a crossover, give both main tracks a vertex where it attaches.
- **Switches:** keep diverging angles under about 30°. Turns are derived from geometry (≤35° deviation passes straight through).
- **Turnbacks:** a free end becomes a dead end, where trains can reverse. Add a crossover before a stub terminus, or arriving trains can't get back to the other track.
- **Checking:** the build prints unroutable hops and trip ends that can't turn back. `?debug=1` in the app shows segment ids and where platforms were mapped.

Service operations so far:
- `extend` (continue a line past a terminus through new stations).
- `truncate` (`{ "op": "truncate", "route": "99", "at": [lon, lat], "keep": [lon, lat], "terminusName": "Arbutus Station" }`): cut every trip at its stop nearest `at` and keep the side toward `keep`. Trips entirely on the cut side are removed.

Buses in scenarios are schedule-only: live and recorded positions are never mixed into a hypothetical network. Run times come from distance and kinematics (`regions/metro-vancouver/config/kinematics.json`) × `padding`, plus `dwell`. More operations (headway patterns, short-turns, removing trips) are future work (see docs/skytrain-viz-PLAN.md §4.8).

## broadway-subway

The Millennium Line extended from VCC–Clark to Arbutus.
- **Track:** OSM's future track near Great Northern Way, plus two sketched connectors at VCC–Clark and a sketched alignment under Broadway (`custom-track.geojson`, approximate).
- **Stations:** positions are approximate.
- **Buses:** the 99 B-Line is cut back to Arbutus. Eastbound buses end at W Broadway & Yew St, the eastbound stop nearest Arbutus, since today's route has no eastbound Arbutus stop.
- **Result:** the weekday peak needs about 38 Millennium trains, up from 33.
