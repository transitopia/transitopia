# @transitopia/data

Node-side access to the region's data on disk, used by both the [pipelines](../../pipelines/README.md) and the [server](../../apps/server/README.md). Runtime code the server needs lives here rather than in `pipelines/`, so the server doesn't depend on the build scripts. Not for the browser: it reads files.

- `src/paths.ts`: the one place that knows where data lives (`regions/`, `var/`, the published data under `var/public/`), plus JSON helpers and `readConfig` (a region config file, parsed with its schema).
- `src/gtfs-zip.ts`, `src/gtfs-day.ts`: reading GTFS zips, and the archived feeds and one service day's trips and stops from them.
- `src/disruptions.ts`: the disruption files and the service dates each one touches.
- `src/infra.ts`: the track graph, platform mapping and overrides as published.
- `src/dispatch-context.ts`, `src/dispatch-debug.ts`: what dispatching a date needs (plan, graph, movements, config), cached per feed, and the `DISPATCH_*` debug settings from the environment ([transit-core → Dispatcher](../transit-core/DESIGN.md#dispatcher)).
