# Disruptions

Track out of service and reduced service for a period, applied by the dispatcher (docs/skytrain-viz-PLAN.md §4.11). Put JSON files here, then run `npm run build:dispatch` (part of `npm run data`); the RT service re-dispatches live when a file changes. Only disruptions with `"status": "confirmed"` apply.

In production, disruptions live in the server's database and are reviewed at https://www.transitopia.org/admin (drafts from alerts, previews on the map, confirm or discard); these files seed a new database and are what local runs without a database use. `npm run corrections -- pull` fetches production's confirmed ones in this format.

Without a database, the server drafts disruptions from TransLink alerts into `drafts/` (gitignored). Review them with `npm run disruptions` (or `npm run disruptions -- pull` to draft from a running service's `/rt/alerts`), then `npm run disruptions -- confirm <id> --keep "<platform stop>"`: alerts rarely say which track stays open, so the command asks for it unless the alert named the platform to board from. Commit the confirmed file.

```json
{
  "disruptions": [
    {
      "id": "2026-09-27-canada-brighouse-single-track",
      "source": "TransLink alert",
      "text": "Canada Line single-tracking between Bridgeport and Richmond-Brighouse",
      "status": "confirmed",
      "active": [{ "from": "2026-09-27T21:00:00-07:00", "until": "2026-09-28T02:00:00-07:00" }],
      "singleTrack": [{ "line": "canada", "between": ["Bridgeport", "Richmond-Brighouse"], "keep": "Lansdowne Station @ Platform 1" }],
      "headway": [{ "line": "canada", "between": ["Aberdeen", "Richmond-Brighouse"], "minS": 600 }]
    }
  ]
}
```

- `active`: ISO 8601 times with offset. Service after midnight belongs to the previous service day.
- `singleTrack`: between two stations (names or parent stop ids), trains in both directions use the track through `keep` (a platform stop id or name). Their stops in between move to that track, the other track closes, and trains cross over wherever the track layout allows. The dispatcher then runs the open track as single track: trains wait for opposing trains to clear it. `pinEnds: true` puts the two end stations on the open track too ("board all trains from Platform 2 at both stations"). Without a `headway` for the line, through trains are thinned to `dispatch.singleTrackHeadwayS`.
- `headway`: trips of `line` (only those serving a station in `between`, if given) run at most every `minS` seconds per direction; the others are cancelled for the period.
- `text` is shown on the affected trains, with `source`.

`build:dispatch` reports anything it couldn't apply (unknown stations, no platform on the open track, unroutable trips).
