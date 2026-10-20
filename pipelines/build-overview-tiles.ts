// The transit overview tileset (packages/transit-core/DESIGN.md#overview-tiles): every feed's routes,
// from its plan for today, at the zooms below a region's engine, with static colours. Bus corridors
// (divided roads merged) and buses without corridors are coloured by how often buses pass on
// regular weekdays, as the map's "Day" (CorridorFrequency, corridorStyle); routes with their own
// colour (SkyTrain, the 99, RapidBus, Blink, SeaBus, WCE) are drawn in it.
// Input:  var/public/data/feeds/<feed>/manifest.json and the plan it names for today
// Output: var/public/tiles/<OVERVIEW_TILES_NAME>.pmtiles (published to the maps bucket by the server)
//
//   tsx pipelines/build-overview-tiles.ts

import { join } from "node:path";
import {
  PUBLIC_DIR,
  exists,
  log,
  readFeeds,
  readManifest,
} from "@transitopia/data/paths.ts";
import {
  OVERVIEW_TILES_FILE,
  readPlanLines,
  tileInput,
  tippecanoe,
} from "@transitopia/data/plan-tiles.ts";
import {
  CorridorFrequency,
  corridorStyle,
  shortCorridorNeighbours,
} from "@transitopia/transit-core/plan/corridor-frequency.ts";
import {
  brandedRoutes,
  drawsCorridors,
  overviewCorridors,
  routeFeatures,
  type TileFeature,
} from "@transitopia/transit-core/plan/tiles.ts";
import {
  feedForDate,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import { localDate } from "@transitopia/transit-core/time.ts";
import { bandIndex } from "@transitopia/shared/frequency.ts";
import {
  ENGINE_MIN_ZOOM,
  OVERVIEW_LAYERS,
} from "@transitopia/shared/transit-overview.ts";

/** The lowest zoom with tiles (the whole of Canada at once). */
const MIN_ZOOM = 3;

/** A plan's lines for the overview, coloured as the map's "Day" colours them. */
export function overviewFeatures(plan: ServicePlan): TileFeature[] {
  const out: TileFeature[] = [];
  const brands = brandedRoutes(plan);
  const tier = (wait: number | undefined) =>
    wait !== undefined && Number.isFinite(wait) ? bandIndex(wait) : -1;
  if (drawsCorridors(plan)) {
    const cf = new CorridorFrequency(plan);
    const corridors = overviewCorridors(plan);
    const rates = cf.frequencies("weekdays", () => true);
    const brandOf = cf.routeDirs.map((rd) =>
      brands.findIndex((r) => r.key === rd.route),
    );
    const { waits, brands: brandAt } = corridorStyle(
      cf,
      cf.combosOfCorridors(corridors),
      shortCorridorNeighbours(corridors),
      brandOf,
      () => rates,
    );
    corridors.forEach((c, i) => {
      const t = tier(waits[i]);
      if (t < 0) return;
      const b = brandAt.get(i);
      out.push({
        type: "Feature",
        properties: {
          tier: t,
          ...(b === undefined ? {} : { color: brands[b]!.color }),
        },
        geometry: { type: "LineString", coordinates: c.coords },
        tippecanoe: { layer: OVERVIEW_LAYERS.corridors },
      });
    });
  }
  const byKey = new Map(plan.routes.map((r) => [r.key, r]));
  for (const f of routeFeatures(plan)) {
    const route = byKey.get(String(f.properties["route"]))!;
    // A ferry's berth pairs not in use by default aren't worth drawing zoomed out.
    const pair = f.properties["berthPair"];
    if (pair !== undefined && pair !== plan.ferry?.default) continue;
    const regular = route.kind === "bus" && route.category === "regular";
    const t = regular ? tier(route.weekdayWait) : 0;
    if (t < 0 || f.properties["empty"]) continue;
    out.push({
      type: "Feature",
      properties: {
        kind: route.kind,
        ...(regular ? { tier: t } : { color: route.color }),
      },
      geometry: f.geometry,
      tippecanoe: { layer: OVERVIEW_LAYERS.routes },
    });
  }
  return out;
}

async function main() {
  const today = localDate(Date.now());
  const features: TileFeature[] = [];
  for (const feed of await readFeeds()) {
    const entry = feedForDate(await readManifest(feed.id), today);
    const path = entry && join(PUBLIC_DIR, entry.path);
    if (!path || !(await exists(path))) {
      log(`${feed.id}: no plan for ${today}; left out of the overview`);
      continue;
    }
    const f = overviewFeatures(await readPlanLines(path));
    log(`${feed.id}: ${f.length} lines from ${entry.version}`);
    features.push(...f);
  }
  await tippecanoe(tileInput(features), OVERVIEW_TILES_FILE, [
    `--minimum-zoom=${MIN_ZOOM}`,
    `--maximum-zoom=${ENGINE_MIN_ZOOM - 1}`,
    "--drop-rate=1",
    "--no-feature-limit",
    "--no-tile-size-limit",
  ]);
  log(`Wrote ${OVERVIEW_TILES_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
