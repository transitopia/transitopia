# @transitopia/transit-map

The transit engine on a host MapLibre map: the clock, playback, real-time data in the browser, and the WebGL layers that draw vehicles. No UI framework: the site's React controls ([apps/web](../../apps/web/README.md#transit-mode)) read its snapshot store and call its methods. The models it plays back are in [packages/transit-core/DESIGN.md](../transit-core/DESIGN.md).

```ts
const engine = await TransitEngine.create(map, { dataBase, apiBase, theme });
const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot); // in React
engine.toggle(); engine.setRate(10); engine.seek(t); engine.goLive(); engine.select(id);
engine.setTheme("dark");   // before the host swaps the basemap style
engine.dispose();
```

`dataBase` is where the published transit data lives (`var/public/` locally, served at `/dev-data/`; `https://data.transitopia.org/` in production). `apiBase` is the server; without it the engine makes no real-time requests at all and shows schedules only.

## How a frame is drawn

clock → playback → WebGL, every animation frame, without React. Positions are a pure function of (plan, overlays, t), so seeking, rewinding and fast-forwarding cost nothing. Hosts read a small snapshot (`TransitSnapshot` in `engine.ts`: the shown time and service date, play state, the slider's span and the bus coverage within it, the real-time mode, service notices, previews, routes, the selected vehicle, and the datasets drawn), throttled to a few updates a second plus every discrete change.

| File | What |
|---|---|
| `src/engine.ts` | `TransitEngine`: mounts the layers, owns the clock and stores, exposes controls and the snapshot. `debugHandle()` is `window.transit` on `/transit`. |
| `src/clock.ts` | The clock: rate, pause, live, and the playback rates offered (−300× to 300×) |
| `src/plans.ts` | Loads the manifest, the plan for a date's feed, movement files, dispatch patches (static, live and preview versions) and the track network |
| `src/rt.ts` | Real-time buses in the browser: polls `/rt/live` near now and fetches recorded hours elsewhere, plus service changes and travel-time profiles |
| `src/ais.ts` | SeaBus AIS: polls `/rt/ais/fixes` for dates in progress and turns fixes into schedule corrections |
| `src/url.ts` | Shareable view state in the query string ([below](#url-state)) |
| `src/prefs.ts` | Per-viewer preferences in local storage (theme, hidden routes, legend state), guarded so they work without it |
| `src/layers/` | MapLibre layers ([below](#rendering)) |

## Rendering

- **Vehicles** are drawn by a small WebGL2 layer (`src/layers/gl-polygons.ts`) through MapLibre's public `CustomLayerInterface`. Geometry is built on the CPU each frame (a few hundred to-scale shapes) relative to the viewport centre, with the offset folded into the matrix in float64, so positions stay precise at station zoom. Picking is done on the CPU too. This replaced deck.gl, whose MapLibre integration reads private `map.transform` internals that MapLibre v6 removed; keep to the public API.
- **Vehicle shapes** (`src/layers/vehicles.ts`): to scale when zoomed in (trains as chains of car polygons following the track's curvature, buses and vessels as outlines), fixed-size markers when zoomed out. Observed and interpolated positions are solid route colour with a thin darker edge (near-black in the dark theme); **estimated** ones are the route colour at 62% opacity with a white edge, so an estimate never looks observed. The key in the site draws the same two shapes.
- **Track** (`src/layers/tracks.ts`): every SkyTrain track, switch and platform from the infrastructure model, with one line per corridor at low zoom and true geometry at station zoom (z ≥ 15–16). `?debug=1` adds segment ids and platform markers.
- **Route lines and stops** (`src/layers/static.ts`): GTFS shapes for buses, SeaBus (the day's berth pair solid, the other dotted) and WCE; bus sections with little or no passenger service dotted; bus stops as ticks toward their side of the street. Hidden routes (by category in the site), "live only" (estimated vehicles not drawn, except the selected one) and hidden stations and stops are per-browser preferences (`src/prefs.ts`). Hiding a route only stops it being drawn: the selected vehicle stays drawn (and computed) whatever its route or provenance, the open route card's route is still computed so its counts stay true, and station and stop cards list every route's departures. Camera follow (`select(id, { follow })`, `setFollowing`) holds the selected vehicle at the centre of the area the host's chrome leaves clear (`setViewPadding`): while following, that area is the map's padding and the vehicle is re-centred every frame the map isn't moving (a `jumpTo` would cancel a gesture), and scroll and pinch zoom go around the centre. A user drag stops it; the padding is then removed without moving the view, once the map is still. Elsewhere ("Centre on map", bringing a tapped place clear of its card) an `easeTo` offset is used instead of padding, so the centre written to the URL stays the map's own. Tapping a station or bus stop selects it instead (`selectPlace`; `?place=`): the snapshot's `place` carries its departures after the shown time, grouped, with frequencies and shared stretches, using the same real-time corrections as the vehicles ([transit-core → Departures](../transit-core/DESIGN.md#departures)), and the map rings it (`setSelectedPlace` in `src/layers/static.ts`). Each departure group also carries its stop ids and the vehicle on the map running its next departure (matched by service date and trip), so a card can open it. A card opened from another (`open(target, from)`, where `target` is `{ vehicle }` or `{ place }` and `from` the opening card's title) keeps a trail that `back()` returns along and the snapshot's `back` names; `select` and `selectPlace` (map taps, closing) clear it. Tapping a route line selects the route (`place` of kind `route`: next-hour frequency and its vehicles out); `routeDays(key)` gives its hourly frequency for each kind of day in the shown feed, cached per feed.
- Layers are re-added after a theme switch: call `engine.setTheme()` before the host swaps the basemap style.
- **Targets**: 60 fps on desktop and ≥ 30 fps on a mid-range phone with ~300 vehicles.

## Real-time data in the browser

- **Buses**: near "now", `rt.ts` polls `/rt/live` (cached at the edge for 10 s); at other times it fetches recorded hours from `/rt/history` (the most recently used hours are cached, and only two load at once, so scrubbing across the day doesn't fetch every hour it passes). Positions are predicted between fixes with the learned travel-time profiles ([packages/transit-core/DESIGN.md → Buses](../transit-core/DESIGN.md#buses)). The time slider is shaded where real bus positions exist (`/rt/coverage`), and a badge says whether buses are live, recorded, loading (recorded data covers the time but hasn't arrived yet), estimated, or unavailable. Service changes (`/rt/changes`) are refetched every minute for today and yesterday.
- **SeaBus**: `ais.ts` runs the AIS matcher on the fixes and passes `ScheduleCorrections` to the schedule engine ([→ SeaBus AIS](../transit-core/DESIGN.md#seabus-ais)).
- **SkyTrain**: the engine never reconciles rail observations itself. It loads the date's dispatch patch: the live version advertised in `/rt/live`, else the static one published with the build, else the base plan.
- **Timetable vehicles** with manual observations use `reconcileScheduled()` (merged with AIS corrections; manual ones win).
- If the server is down or `apiBase` isn't set, everything falls back to the static build, marked *estimated*.

## URL state

The query string holds the transit mode's state: `?date=2026-09-28&t=08:15:00&rate=10&paused=1&select=<vehicle>` (`v` is the older name for `select`), `scenario=<name>`, and `preview=<YYYYMMDD>:<version>,…` for unconfirmed corrections. No time parameters means live. `t` is service-day time, so it may exceed 24:00 for after-midnight trips. The map position is in the hash, shared with the other modes ([apps/web](../../apps/web/README.md#modes-and-url-state)).
