# Transitopia website

The single-page application at https://www.transitopia.org: React 19, TypeScript, Vite, Tailwind, [wouter](https://github.com/molefrog/wouter) for routing, and MapLibre GL JS v6 on the Protomaps basemap. How it fits with the rest: [docs/DESIGN.md](../../docs/DESIGN.md).

```sh
# Serve at http://localhost:5173 (run this from the repo root)
npm run dev
# Run with production's live data:
VITE_TRANSIT_API=https://api.transitopia.org/ npm run dev
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

## Modes and URL state

The path is the mode (`/transit`, `/cycling`). The map position is in the hash, `#map=z/lat/lng`, and is shared by every mode: switching modes keeps it (`ModeLink`), and old `?z=&lat=&lng=` links are converted. The query string holds the current mode's own state, so switching modes drops it. The layer and panel design should allow two active modes later (e.g. cycling plus stations).

## Transit mode

`TransitMap` creates the engine on mount (`TransitEngine.create(map, { dataBase, apiBase, theme })`) and disposes it on unmount. The engine and `transit-core` are their own chunk, loaded only on `/transit`, as is MapLibre itself. The per-frame path (clock → playback → WebGL) never goes through React: components read the engine's snapshot with `useSyncExternalStore` and call its methods ([packages/transit-map](../../packages/transit-map/README.md)).

- **Time bar** (`TimeBar.tsx`): play and pause, the time and date (bounded to the published timetables, with the service type, e.g. "Weekday (Mon–Thu)"), speed (−300× to 300×), Live, and a slider across the service day (from 03:00), shaded where real bus positions exist. A badge says whether buses are live, recorded (or loading) or estimated, and the bar warns when it's showing a preview of unconfirmed corrections. Keyboard: space plays and pauses, ←/→ move a minute (shift: ten), L goes live, [ and ] change speed. On phones it's a compact bottom bar.
- **Legend** (`TransitLegend.tsx`): each line and route, which can be hidden; collapsible.
- **Vehicle card** (`VehicleCard.tsx`): tap or click a vehicle to follow it (and centre the map on it): its trip, next stop and schedule, what it's doing between trips (leaving the yard, turning back, layover, to the yard), consist or vessel name, speed, notes (service changes, detours, shifted GPS), and its provenance in plain words: an observed position with the time of the last fix, or "Estimated from schedule". SkyTrain runs are labelled "Train (inferred)". TransLink's legend is shown for TransLink vehicles.
- Outside the region, `/transit` says transit data isn't available there.

## Cycling mode

The cycling and micromobility layer for British Columbia, built by our Planetiler profile ([map-layers](../../map-layers/README.md)) and served as `transitopia-cycling-british-columbia.pmtiles`. Clicking a feature shows its details, loaded on demand from the OSM API.

## Attribution

The site replaces MapLibre's attribution control with its own (`src/Attribution/`), which credits exactly the data on screen: each mode declares what it draws with `useDatasets([...])`, and the transit engine reports the datasets it's drawing. Entries come from the registry in [packages/shared](../../packages/shared/src/datasets.ts). Design: [docs/DESIGN.md → Attribution](../../docs/DESIGN.md#attribution).

## Themes

Light and dark basemaps come from [packages/map-style](../../packages/map-style/README.md). Every overlay re-adds its layers after a theme switch: depend on `useStyleGeneration()` (cycling), or call `engine.setTheme()` before the style swaps (transit).

## Admin

`/admin` (`src/Admin/Admin.tsx`) is the review queue for corrections: the server's status and health, recent jobs, disruptions drafted from TransLink alerts, observation sets, and alerts the parser couldn't draft. Admins edit, preview, confirm, discard and reopen corrections there. Sign-in is with GitHub through the server; the token comes back in the URL fragment, is removed from the address bar at once, and is kept in local storage ([apps/server → Admin API and sign-in](../server/README.md#admin-api-and-sign-in)).

## Analytics

Cloudflare Web Analytics (cookieless, no personal data) is injected at build time when `CF_WEB_ANALYTICS_TOKEN` is set (`vite.config.ts`), or by Cloudflare itself when Web Analytics is turned on in its dashboard.
