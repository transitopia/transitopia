# Transitopia website

The single-page application at https://www.transitopia.org: React 19, TypeScript, Vite, Tailwind, [wouter](https://github.com/molefrog/wouter) for routing, and MapLibre GL JS v6 on the Protomaps basemap. How it fits with the rest: [docs/DESIGN.md](../../docs/DESIGN.md).

```sh
# Serve at http://localhost:5173 (run this from the repo root)
npm run dev
# Run with production's data and live API (both, so buses match transitopia.org):
VITE_TRANSIT_DATA=https://data.transitopia.org/ VITE_TRANSIT_API=https://api.transitopia.org/ npm run dev
# Build to apps/web/dist (what Cloudflare Pages builds)
npm run build -w @transitopia/web
```

Locally the site reads the pipelines' output from `var/public/`, served at `/dev-data/` by `vite.config.ts`, and the cycling layer from `apps/web/public/` (see the repo [README](../../README.md#how-to-run-transitopia-locally)). Production locations are in `.env.production`; every data URL goes through `src/config.ts`.

## Layout

| Path | What |
|---|---|
| `src/App.tsx` | Routes: `/transit`, `/cycling`, `/admin`; `/` opens `/transit`, and old `/walking` links go to `/cycling` |
| `src/Map/` | The one MapLibre map every mode shares, its context, the basemap, and the position in the URL |
| `src/TransitMap/` | `/transit`: mounts the transit engine and renders its controls |
| `src/CyclingMap/`, `src/OSMData/` | `/cycling`: the cycling layer, and OSM feature details (e.g. bike parking) loaded from the OSM API |
| `src/Attribution/` | The attribution control |
| `src/Admin/` | `/admin`, without the map |
| `src/Theme/` | Light, dark, or the system's |
| `src/components/` | Shared chrome: the logo, every icon (`Icon.tsx`: Bootstrap's filled icons and our own line icons, all on a 16-unit grid; no inline SVGs elsewhere), the menu button (`Menu.tsx`), the segmented choice (`SegmentedChoice.tsx`), the feature card, the header's mode switch and the layers panel |

## Modes and URL state

The path is the mode (`/transit`, `/cycling`). The map position is in the hash, `#map=z/lat/lng`, and is shared by every mode: switching modes keeps it (`ModeLink`), and old `?z=&lat=&lng=` links are converted. The query string holds the current mode's own state, so switching modes drops it. The layer and panel design should allow two active modes later (e.g. cycling plus stations).

## Header and layers

The header holds the logo and the mode switch (`ModeSwitch.tsx`): a segmented control with each mode's icon (and its name from tablet width up). Other modes are links; the active mode's pill carries a chevron and opens that mode's layers panel (`LayersPanel.tsx`). The panel drops down from the header: a popover under it on desktop, a full-width panel over a dimmed map on phones (never a bottom sheet, which is for feature cards). Escape, a press outside it, Done (phones) or switching modes closes it. The header owns the panel's open state and a portal host inside the header element; the active mode renders its own rows into it, because only the mode knows its layers. Choices are remembered per browser.

- **Transit** (`TransitLayers.tsx`): one switch per route category with routes in it (`category` in the feed's `config/feeds/<feed>/routes.json`, baked into `plan.json`: Rapid Transit: dedicated right of way (SkyTrain, SeaBus, West Coast Express); Frequent Bus: the 99 B-Line and RapidBus; Regular Bus: every other bus, drawn so far only in Greater Victoria (the 15 and 70), so elsewhere that switch stays hidden until the all-buses work), Vehicles: All or Live only (estimates hidden; the selected vehicle stays), Stations & stops, and the key (live and estimated vehicle shapes, dashed limited service). The engine keeps these preferences (`setRoutesHidden`, `setLiveOnly`, `setStopsShown`).
- **Cycling** (`CyclingLayers.tsx`): protected lanes and paths, painted lanes (including shared lanes on busy streets), local street bikeways, bike parking, under construction, and "All ages & abilities only" (hides painted and busy shared lanes). The categories follow the tiles' comfort levels; `cyclingFilters()` in `cycling-map-layers.ts` turns the choices into layer filters, applied in place.

## Transit mode

`TransitMap` creates the engine for the region in view (`TransitEngine.create(map, { dataBase, apiBase, region, theme, config })`, with that region's config and feed from `regions.ts`) and disposes it on unmount. The region in view is the one whose bbox covers most of the map (`regionInView`); when another comes into view the engine is recreated for it, keeping the time but not a selected vehicle or place ([docs/DESIGN.md → Regions and feeds](../../docs/DESIGN.md#regions-and-feeds)). Opened without a map position, `/transit` shows Metro Vancouver. The engine and `transit-core` are their own chunk, loaded only on `/transit`, as is MapLibre itself. The per-frame path (clock → playback → WebGL) never goes through React: components read the engine's snapshot with `useSyncExternalStore` and call its methods ([packages/transit-map](../../packages/transit-map/README.md)).

- **Time bar** (`TimeBar.tsx`): play and pause, the time and date (a button opening the date picker, bounded to the published timetables), a speed stepper (−300× to 300×), Live or Go live, and a slider across the service day (from 03:00), shaded where real bus positions exist. Badges say whether buses are live, recorded (or loading) or estimated, flag service changes, and warn when it's showing a preview of unconfirmed corrections (narrower than a tablet these badges and "Not live" are dropped, and the service-day label truncates, so the controls always fit). Keyboard: space plays and pauses, ←/→ move a minute (shift: ten), L goes live, [ and ] change speed. Its states are in [Time and not-live](#time-and-not-live).
- **Layers** (`TransitLayers.tsx`): see [Header and layers](#header-and-layers).
- **Vehicle card** (`VehicleCard.tsx`, a [feature card](#feature-cards)): tap or click a vehicle to select it (and [follow](#follow) it): its route and destination (a bus's card is titled by number and destination, "R4 to Joyce Station", with a bus icon in the route's colours, and its Route row is a chip naming the full route that opens the [route card](#route-cards)), its provenance in plain words with the map's marks (live with the age of the last fix, recorded, or estimated from the schedule), lateness and speed, what it's doing (next stop, at a stop, leaving the yard, turning back, layover, to the yard), notes (service changes, detours, shifted GPS), trip, inferred run, vehicle, consist or vessel name, and the data's source. The ⋯ menu follows it or stops following, centres the map on it, shares a link (the URL names the vehicle and time), or shows only its route. TransLink's legend is shown for TransLink vehicles.
- Outside every region, `/transit` says transit data isn't available there, with a link to each region.

## Cycling mode

The cycling and micromobility layer for British Columbia, built by our Planetiler profile ([map-layers](../../map-layers/README.md)) and served as `transitopia-cycling-british-columbia.pmtiles`. Clicking a feature shows its details, loaded on demand from the OSM API.

## Time and not-live

Every transit card follows the map's time, date and speed, so the past, live and the future stay in step; bike cards ignore it (OpenStreetMap has no history). Amber means "not live" and nothing else; green "Live" appears only when live (`clock.isLive()`: playing at 1× within seconds of now, so pausing leaves live).

- Not live, the time bar gets an amber border and an amber status line ("Paused", "Replaying at 10×", or "Projected at 60×" for the future, with the date), a "Not live" badge, and Go live in place of the Live pill.
- Every time-dependent card opens with an amber banner: "Not live · Showing Tue 6 Oct, 08:00" (or "projected" for the future) and Go live, inside an amber border (`notLive` on `InfoCard`; `timeState()` in `src/TransitMap/format.ts`). There's no amber frame or tag over the map itself.
- Phones: the bar is compact (pause, time, Live) only while live; any other state expands it (slider, date, speed), and Go live collapses it. With a card open, the time shrinks to a pill at the top (amber "Showing Tue 6 Oct · 08:00" when not live); its play button plays and pauses, and the rest opens the full controls there.

## Follow

Tapping a vehicle follows it with the camera when playback is at 10× or slower (live, 1×, 10×), not faster: constant panning at 60×+ is disorienting (the 10× cutoff is a guess). The camera holds the vehicle exactly at the centre of the part of the map the chrome leaves clear (`setViewPadding`, measured from every element marked `data-map-overlay` by `src/TransitMap/overlayPadding.ts`; each counts against whichever edge gives up the least of the map), so the map moves under it smoothly rather than in jumps. When that area changes while following (the card opening just after the tap starts the camera moving, or resizing), the camera eases to the new centre, re-aiming a move already under way, rather than jumping. Scroll and pinch zoom go around the vehicle while following. Tapping another vehicle while following eases the camera over to it and follows that one instead (under the same speed rule). Dragging the map, closing the card or selecting something else stops it; zooming doesn't, and neither does the end of a trip (the selection is the vehicle, which carries on through turnbacks and its next trips). A "Following <vehicle> · Stop" pill shows meanwhile (`FollowPill.tsx`: top centre on desktop, under the time pill on phones), and the card's menu item reads "Stop following". "Centre on map" uses the same clear area.

## Station and stop cards

Tapping a station (its marker or name), a bus exchange (its marker or name: drawn like a station, in grey) or a bus stop (its tick or label) opens its card (`src/TransitMap/PlaceCard.tsx`); the engine picks vehicles first, then stations, then exchanges, then stops, and the URL keeps the choice (`?place=station:<id>`, `exchange:<id>` or `stop:<id>`). A station's card has a section each for its trains (SkyTrain, West Coast Express), its sailings (SeaBus) and the buses from its bus bays; an exchange's card lists every bay's buses. A card's route chips list every route that stops there, including the feed's bus routes the map doesn't draw yet (grey badges, from the plan's [route catalogue](../../packages/transit-core/DESIGN.md#route-catalogue)); those have no departure rows, and the footer says so. A bus stop's card shows its number from the sign ("Stop #50123", GTFS `stop_code`; plans built before it have none). Each bay is still a stop of its own: tap its tick, pick "Only Bay 7" from the card's ⋯ menu or "View stop" from a bus row's menu ([below](#cross-references)), and a bay's card goes back with "All of …" ([packages/transit-core/DESIGN.md → Bus exchanges](../../packages/transit-core/DESIGN.md#bus-exchanges)). The map rings the selected place and brings it clear of the card. Departures (from the engine's snapshot, [packages/transit-core/DESIGN.md → Departures](../../packages/transit-core/DESIGN.md#departures)) are grouped by route and destination, one row per group, ordered by platform (or bus bay) number and then by the soonest, so a station lists Platform 1's trains first and a station's buses by bay; a street stop's rows go by the soonest: the next time large ("3 min"), the next two smaller below ("9m 15m"), each with its mark; clock times when not live, never countdowns. Each row has the platform (or bus bay) where known, cancelled trips, and a [frequency](#service-frequency) line for the hour after the map's time. Groups that share a stretch from here are combined. When all their trips leave from one platform or bay, their rows are kept together there, tied by a grey rail on the left, with what they add up to under them ("Any of these, to Columbia · every ~3m · Good"; "Either one" for two). Otherwise (several platforms, or a street stop) they get a combined row on top ("Any Canada Line to Bridgeport" for one route's branches, "R5 or 14, to Renfrew St" for several routes), with the platforms they leave from and their combined frequency. Live predictions appear only where the browser already has them (bus delays carried from GTFS-realtime); everything else is the timetable, marked "~". Recorded arrivals in past cards need the server's observed stop times and aren't shown yet.

## Cross-references

Tapping a departure row on a station, exchange or stop card opens what it names (`GroupRow` in `src/TransitMap/PlaceCard.tsx`): a menu (the shared `src/components/Menu.tsx`, with the row as its trigger) with "View route: 99 B-Line", "View stop: Bay 5" (bus rows at a station or exchange, when the row leaves from one bay) and "View bus" / "View train" / "View ferry" (only when the vehicle running its next departure is on the map: the engine matches it by trip, `vehicle` on the snapshot's departure groups). The menu opens even when the route is all it offers, so rows behave the same whether or not their vehicle is out yet. The route chips under a station's or stop's title open the route too (they look the same, darkening on hover). The card opened this way gets a back strip at the top naming the card it came from (`back` on `InfoCard`); Back returns there, several levels deep. The engine keeps that trail (`open(target, from)`, `back()`, the snapshot's `back`); tapping the map, closing a card or any other selection forgets it. The URL is replaced, not pushed, so the browser's Back button doesn't step through cards. The ⋯ menu's "Only Bay 7" and "All of …" open their cards the same way. Escape closes an open menu (or the layers panel) first, then the card. A vehicle opened from a row is followed under the same rule as tapping it ([Follow](#follow)).

## Route cards

Tapping a route line (bus, ferry and rail lines, and SkyTrain track) opens its card (`src/TransitMap/RouteCard.tsx`; `?place=route:<key>`), after vehicles, stations and stops. It says how many of its vehicles are out (and how many live, or recorded when not live), how often it runs in the hour from the map's time ("Every 3 min · Good", with the average wait), and a day strip of hourly cells from 05:00 to 01:00 in the [frequency](#service-frequency) colours, the current hour ringed. A select picks one of the feed's own kinds of day (dates on which the same services run, the shown day's first, labelled by the service describer), not a fixed weekday/Saturday/Sunday. A route the map doesn't draw (from a stop card's grey chip, or `?place=route:25`) gets the same card with "Not on the map yet" instead of vehicle counts, and only Share in its ⋯ menu. Everything comes from the timetable: trips per hour in the busier direction (`packages/transit-core/src/schedule/frequency.ts`). How the route actually ran (average gaps and lateness from the nightly statistics) needs a server endpoint and isn't shown yet. The ⋯ menu shows only this route (or all again), fits the route on the map, and shares a link.

## Service frequency

How often something runs is shown in bands: Good, OK, Poor, Bad, the same for every route in every region (≤6, ≤12, ≤20 and over 20 minutes between departures; `BANDS` in `src/TransitMap/frequency.ts`) and colours per theme (`--band-*` in `src/index.css`), blue to red, never green (live) or amber (not live). The band's name always shows next to its colour. Helpers: `src/TransitMap/frequency.ts`.

## Feature cards

Everything tapped on the map opens the same card (`src/components/InfoCard.tsx`): a header (icon tile in the route's or mode's colours, an eyebrow saying what kind of thing it is, title, subtitle, ⋯ menu, close), an optional status line, chips, sections of rows divided by 1 px rules, and a footer saying where the data comes from. Actions (centre, share, show only this route, and later follow) live only in the ⋯ menu, so the card body is information, except that a station's or stop's departure rows open the cards they name ([Cross-references](#cross-references)). Times and positions carry one set of marks: live is a green dot, recorded a grey dot, estimated a grey "~" before the time; green appears only when live. On desktop the card is a 360 px panel at the top right; on phones it's a bottom sheet. Its colours are the `--card-*` and `--mark-*` properties in `src/index.css`, per theme.

- Vehicles: `src/TransitMap/VehicleCard.tsx`; stations and stops: `PlaceCard.tsx` ([above](#station-and-stop-cards)); routes: `RouteCard.tsx` ([above](#route-cards)).
- Bike routes (`src/CyclingMap/BikeRouteCard.tsx`) from the cycling tiles' attributes, and bike parking (`BikeParkingCard.tsx`) loaded from the OSM API, with a link to view or edit it there. Bike cards ignore the map's time: OpenStreetMap has no history. The selected feature is highlighted on the map; bike parking stays a faint dot.

## Attribution

The site replaces MapLibre's attribution control with its own (`src/Attribution/`), which credits exactly the data on screen: each mode declares what it draws with `useDatasets([...])`, and the transit engine reports the datasets it's drawing. Entries come from the registry in [packages/shared](../../packages/shared/src/datasets.ts). Design: [docs/DESIGN.md → Attribution](../../docs/DESIGN.md#attribution).

## Themes

Light and dark basemaps come from [packages/map-style](../../packages/map-style/README.md). Every overlay re-adds its layers after a theme switch: depend on `useStyleGeneration()` (cycling), or call `engine.setTheme()` before the style swaps (transit).

## Admin

`/admin` (`src/Admin/Admin.tsx`) is the review queue for corrections: the server's status and health, recent jobs, disruptions drafted from TransLink alerts, observation sets, and alerts the parser couldn't draft. Admins edit, preview, confirm, discard and reopen corrections there. Sign-in is with GitHub through the server; the token comes back in the URL fragment, is removed from the address bar at once, and is kept in local storage ([apps/server → Admin API and sign-in](../server/README.md#admin-api-and-sign-in)).

The page is `Admin.tsx` (sign-in and the queue's sections), with `Status.tsx`, `DisruptionCard.tsx`, `ObservationCard.tsx`, `NewCorrection.tsx`, `JsonEditor.tsx`, and `Review.tsx` for what both cards share (state badge, review buttons, preview links). `api.ts` fetches with react-query, parsing every response with the admin API's zod schemas in [`@transitopia/shared/admin-api.ts`](../../packages/shared/README.md), the same ones the server types its responses with; each card's writes reload the queue.

## Current location

The location button under the map controls (MapLibre's `GeolocateControl`, in `src/Map/Map.tsx`, so every mode has it) asks for the browser's location. Tapping it centres the map on you and follows as you move. Panning the map, or centring on a vehicle, stops following but keeps your dot, and tapping again turns it off. Outside the map's bounds (BC) the button shows an error instead of moving the map. The position stays in the browser: it is never sent to our server or recorded. Browsers only offer it on HTTPS (and `localhost`).

## Search metadata

The site renders client-side, so `index.html` carries what crawlers and link previews read without running JavaScript: the title, a site-wide description, Open Graph and Twitter card tags, a `<noscript>` summary, and `WebSite` structured data for the site name in Google's results. Each mode's route renders `<PageMeta>` (`src/components/PageMeta.tsx`), which swaps in that mode's description and adds a canonical link to `https://www.transitopia.org/<mode>` without the query string, so variants such as `?date=…` count as one page. The canonical link can't go in `index.html`: every route is served that same file, and `/transit` and `/cycling` aren't duplicates. `/` only redirects, so it has none.

## Home screen

On phones the map runs under the status bar, rounded corners and home indicator (`viewport-fit=cover`), while the chrome keeps to the safe area: `<Map>` renders every overlay inside `.map-chrome`, which is inset by `env(safe-area-inset-*)` at the top and sides (`src/index.css`), and MapLibre's control corners get the same insets. Position new overlays inside it, not against the screen. The site header is `<Map>`'s `header`, outside `.map-chrome`: on phones (below `sm`) it's a bar across the top, under the status bar, and the chrome and MapLibre's controls start below it (`--phone-header-height`); on larger screens it floats at the top left. On phones the page background is the header's colour (`--header-background`), because iOS Safari colours the band behind the status bar from it rather than from `theme-color`; `theme-color` follows the same colour for other browsers (`src/Theme/Theme.tsx`). The credits line is pinned to the bottom edge, its ends padded clear of the rounded corners (`--screen-corner-inset`). The chrome is positioned in the map's own box rather than against the viewport, because installed iOS apps report a viewport shorter than the screen. Under the status bar iOS draws its own blur over the map and picks the text colour itself; `apple-mobile-web-app-status-bar-style` makes no difference there (seen on iOS 27).

The site can be added to a phone's home screen as "Transitopia". `public/manifest.webmanifest` gives the name, icons and `start_url` (Android and desktop installs). iOS uses `apple-touch-icon.png` and `apple-mobile-web-app-title` from `index.html` instead, because it can't use SVG icons. It also starts from whatever URL was open when the page was added, not from `start_url`. So when the page is opened as an installed app, `src/startup.ts` drops the query string (time, selection, preview), keeping the path and map position: the app always opens live.

The PNG icons are rendered from `public/transitopia-logo-app-icon.svg` (square, full-bleed: iOS and Android round the corners themselves). Regenerate them after changing it (from `apps/web/public`):

```sh
for n in 180:apple-touch-icon 192:transitopia-app-icon-192 512:transitopia-app-icon-512; do
  rsvg-convert -w ${n%%:*} -h ${n%%:*} transitopia-logo-app-icon.svg -o ${n#*:}.png
done
```

## Analytics

Cloudflare Web Analytics (cookieless, no personal data) is injected at build time when `CF_WEB_ANALYTICS_TOKEN` is set (`vite.config.ts`), or by Cloudflare itself when Web Analytics is turned on in its dashboard.
