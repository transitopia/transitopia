// What a plan's tiles hold (packages/transit-core/DESIGN.md#plan-tiles): every line the map draws for it,
// as GeoJSON features tagged with their tile layer and zooms for tippecanoe. The map styles these
// lines; it doesn't draw any of its own. Bus corridors are numbered as in the plan (their feature
// id), and SkyTrain's line pieces as in lines.geojson, so the map's feature state finds them;
// everything else is styled by its properties.

import type { Feature, Geometry } from "geojson";
import type { InfraCollection } from "../infra/types.ts";
import type { LineGeometry } from "../infra/line-geometry.ts";
import { routeSections } from "./coverage.ts";
import {
  patternTripCounts,
  type PlanCorridor,
  type PlanRoute,
  type ServicePlan,
} from "./types.ts";

/** The tile layers (`source-layer`s) of a plan's tiles. */
export const PLAN_TILE_LAYERS = {
  /** Corridors from CORRIDOR_DETAIL_ZOOM: each carriageway its own line. */
  corridors: "corridors",
  /** Corridors below it: divided roads' carriageways merged into one line. */
  overviewCorridors: "corridors-overview",
  /** Routes along their shapes: buses without corridors, SeaBus, WCE, SkyTrain without track. */
  routes: "routes",
  /** SkyTrain's centrelines, ribbons and tracks (infra/line-geometry.ts), in a region with track-level rail. */
  railLines: "rail-lines",
  /** Track segments drawn on their own: yards, and track under works. */
  railTracks: "rail-tracks",
} as const;

/** Detailed corridors are drawn from this zoom, the overview's below it. */
export const CORRIDOR_DETAIL_ZOOM = 14;
/** A plan's tiles cover these zooms; the map overzooms the last (a region's engine starts at the first). */
export const PLAN_TILES_MIN_ZOOM = 10;
export const PLAN_TILES_MAX_ZOOM = 14;

/** Draw order of routes along their shapes, by kind. */
const KIND_ORDER: Record<string, number> = { bus: 0, shape: 1, skytrain: 2 };

/** A feature with its tile layer and zooms (tippecanoe's per-feature extension). */
export type TileFeature = Feature<
  Geometry,
  Record<string, string | number | boolean>
> & {
  tippecanoe: { layer: string; minzoom?: number; maxzoom?: number };
};

/** A region's SkyTrain track and line geometry (build-infra's tracks.geojson and lines.geojson). */
export interface RailInput {
  tracks: InfraCollection;
  lines: LineGeometry;
}

/**
 * Whether the plan draws its bus routes as corridors: built with them (pipelines), or with their
 * metadata (the browser's plan).
 */
export function drawsCorridors(plan: ServicePlan): boolean {
  return Boolean(
    plan.corridorInfo
    || plan.overviewCorridors?.length
    || plan.corridors?.length,
  );
}

/**
 * Bus routes with their own colour (the 99 and RapidBus: category "frequent"), drawn along their
 * corridors in it; a corridor's `brand` is an index into this list.
 */
export function brandedRoutes(plan: ServicePlan): PlanRoute[] {
  return plan.routes.filter(
    (r) => r.kind === "bus" && r.category !== "regular",
  );
}

/** The corridors drawn zoomed out (plans without overview corridors draw the detailed ones). */
export function overviewCorridors(plan: ServicePlan): PlanCorridor[] {
  return plan.overviewCorridors ?? plan.corridors ?? [];
}

/** The corridors drawn zoomed in. */
export function detailedCorridors(plan: ServicePlan): PlanCorridor[] {
  return plan.corridors ?? plan.overviewCorridors ?? [];
}

/**
 * Every line of a plan, as its tiles hold them: corridors (ids: their index in the plan), routes
 * along their shapes, and with `rail`, SkyTrain's track instead of its GTFS shapes.
 */
export function planTileFeatures(
  plan: ServicePlan,
  rail?: RailInput,
): TileFeature[] {
  const out: TileFeature[] = [];
  const corridor = (
    cs: PlanCorridor[],
    tippecanoe: TileFeature["tippecanoe"],
  ) =>
    cs.forEach((c, id) =>
      out.push({
        type: "Feature",
        id,
        properties: {},
        geometry: { type: "LineString", coordinates: c.coords },
        tippecanoe,
      }),
    );
  if (drawsCorridors(plan)) {
    corridor(overviewCorridors(plan), {
      layer: PLAN_TILE_LAYERS.overviewCorridors,
      maxzoom: CORRIDOR_DETAIL_ZOOM - 1,
    });
    corridor(detailedCorridors(plan), {
      layer: PLAN_TILE_LAYERS.corridors,
      minzoom: CORRIDOR_DETAIL_ZOOM,
    });
  }
  const skip = new Set(
    rail ?
      plan.routes.filter((r) => r.kind === "skytrain").map((r) => r.key)
    : [],
  );
  out.push(
    ...routeFeatures(plan, skip).map((f): TileFeature => ({
      ...f,
      tippecanoe: { layer: PLAN_TILE_LAYERS.routes },
    })),
  );
  if (rail) out.push(...railFeatures(rail, plan.routes));
  return out;
}

/**
 * Routes along their shapes. Buses (only without corridors): split into frequent sections, and
 * limited-service or no-passenger ones (drawn dotted). Ferries: every berth pair, tagged with its
 * pair, so the ones not in use on a day are drawn dotted.
 */
export function routeFeatures(
  plan: ServicePlan,
  skip: ReadonlySet<string> = new Set(),
): Feature<Geometry, Record<string, string | number | boolean>>[] {
  const features: Feature<
    Geometry,
    Record<string, string | number | boolean>
  >[] = [];
  const seen = new Set<string>();
  const byKey = new Map(plan.routes.map((r) => [r.key, r]));
  const busRoutes = new Set(
    drawsCorridors(plan) ?
      []
    : plan.routes.filter((r) => r.kind === "bus").map((r) => r.key),
  );
  const props = (route: PlanRoute) => ({
    route: route.key,
    kind: route.kind,
    mode: route.mode,
    color: route.color,
    order: KIND_ORDER[route.kind] ?? 0,
  });
  for (const sec of routeSections(plan, busRoutes))
    features.push({
      type: "Feature",
      properties: {
        ...props(byKey.get(sec.route)!),
        limited: sec.limited,
        empty: sec.empty,
      },
      geometry: { type: "LineString", coordinates: sec.coords },
    });
  const trips = patternTripCounts(plan);
  for (const p of plan.patterns) {
    const route = byKey.get(p.route)!;
    if (route.kind === "bus" || skip.has(p.route) || !trips[p.id]) continue;
    const pairs: [string | undefined, string][] =
      plan.ferry?.route === p.route ?
        Object.entries(plan.ferry.pairs).map(([pair, v]) => [
          pair,
          v.shapes[p.id] ?? p.shape,
        ])
      : [[undefined, p.shape]];
    for (const [pair, shape] of pairs) {
      const key = `${p.route}|${shape}`;
      const coords = plan.shapes[shape];
      if (seen.has(key) || !coords) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        properties: { ...props(route), ...(pair ? { berthPair: pair } : {}) },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }
  return features;
}

/**
 * SkyTrain's line geometry and the track segments drawn on their own (yards, works), each in its
 * line's colour (`color`: none for yard track and track no line runs on, which the map draws grey).
 */
function railFeatures(
  rail: RailInput,
  routes: readonly PlanRoute[],
): TileFeature[] {
  const color = new Map(routes.map((r) => [r.key, r.color]));
  const out: TileFeature[] = [];
  // Numbered by their place in lines.geojson, as patterns' paths over them (plan/paths.ts) are.
  rail.lines.features.forEach((f, id) => {
    const { lines: _lines, ...p } = f.properties as typeof f.properties & {
      lines?: string[];
    };
    const c = color.get(p.line);
    out.push({
      type: "Feature",
      id,
      properties: { ...p, ...(c ? { color: c } : {}) },
      geometry: f.geometry,
      tippecanoe: { layer: PLAN_TILE_LAYERS.railLines },
    });
  });
  for (const f of rail.tracks.features) {
    if (f.properties.type !== "segment") continue;
    const p = f.properties;
    if (p.kind !== "yard" && !p.works) continue;
    const line = p.lines[0];
    const c = p.kind === "yard" || !line ? undefined : color.get(line);
    out.push({
      type: "Feature",
      properties: {
        kind: p.kind,
        line: line ?? "",
        ...(p.works ? { works: true } : {}),
        ...(c ? { color: c } : {}),
      },
      geometry: f.geometry as Geometry,
      tippecanoe: { layer: PLAN_TILE_LAYERS.railTracks },
    });
  }
  return out;
}
