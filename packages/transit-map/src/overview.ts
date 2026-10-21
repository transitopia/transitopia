// The transit overview's layers (packages/transit-core/DESIGN.md#overview-tiles): every region's routes
// zoomed out, below the zoom a region's engine starts at, with static colours (how often buses pass
// on regular weekdays, as the map's "Day"). The host adds the tileset as a vector source and these
// layers on it; they need no engine. Until a region's engine draws its own lines (its snapshot's
// `linesReady`), the host keeps them drawn further in too (`overviewMaxZoom`), overzoomed, so
// zooming in never leaves the map without lines.

import type {
  ExpressionSpecification,
  LayerSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { FREQUENCY_BANDS } from "@transitopia/shared/frequency.ts";
import {
  ENGINE_MIN_ZOOM,
  OVERVIEW_LAYERS,
} from "@transitopia/shared/transit-overview.ts";

/** The lines' widths (px) per frequency tier at a few zooms, reaching the engine's at its start zoom. */
const TIER_WIDTHS: [number, number[]][] = [
  [4, [0.6, 0.4, 0.3, 0.2]],
  [7, [1.2, 0.8, 0.6, 0.4]],
  [ENGINE_MIN_ZOOM, [2.4, 1.5, 1, 0.6]],
];
/** Routes with their own colour: as wide as the best tier or a little more. */
const BRAND_WIDTHS: [number, number][] = [
  [4, 0.8],
  [7, 1.4],
  [ENGINE_MIN_ZOOM, 2.8],
];
const SKYTRAIN_WIDTHS: [number, number][] = [
  [4, 1],
  [7, 1.8],
  [ENGINE_MIN_ZOOM, 3],
];
/** Worse service recedes, as in the engine (TIER_OPACITY in layers/static.ts). */
const TIER_OPACITY = [1, 1, 1, 0.7];

/** The overview's layers' maxzoom: ENGINE_MIN_ZOOM, or none while no engine draws lines. */
export function overviewMaxZoom(engineLines: boolean): number {
  return engineLines ? ENGINE_MIN_ZOOM : 24;
}

/** The overview's layers on `source`, for a theme, drawn below `maxzoom`. */
export function overviewLayers(
  source: string,
  theme: Theme,
  maxzoom = ENGINE_MIN_ZOOM,
): LayerSpecification[] {
  const tierColors = FREQUENCY_BANDS.map((b) => b.color[theme]);
  const tier = ["get", "tier"] as ExpressionSpecification;
  const byTier = (values: (string | number)[]) =>
    [
      "match",
      tier,
      ...values.flatMap((v, i) => [i, v]),
      values[values.length - 1]!,
    ] as ExpressionSpecification;
  const widths = (stops: [number, number][]) =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...stops.flat(),
    ] as ExpressionSpecification;
  const tierWidth = [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...TIER_WIDTHS.flatMap(([z, w]) => [z, byTier(w)]),
  ] as ExpressionSpecification;
  const common = {
    source,
    maxzoom,
    layout: {
      "line-join": "round" as const,
      "line-cap": "round" as const,
      // Better service on top.
      "line-sort-key": [
        "-",
        0,
        ["coalesce", tier, 0],
      ] as ExpressionSpecification,
    },
  };
  const hasColor = ["has", "color"] as ExpressionSpecification;
  const kind = (k: string) =>
    ["==", ["get", "kind"], k] as ExpressionSpecification;
  return [
    {
      ...common,
      id: "overview-corridors",
      type: "line",
      "source-layer": OVERVIEW_LAYERS.corridors,
      paint: {
        "line-color": byTier(tierColors),
        "line-width": tierWidth,
        "line-opacity": byTier(TIER_OPACITY),
      },
    },
    {
      ...common,
      id: "overview-buses",
      type: "line",
      "source-layer": OVERVIEW_LAYERS.routes,
      filter: ["all", kind("bus"), ["has", "tier"]],
      paint: {
        "line-color": byTier(tierColors),
        "line-width": tierWidth,
        "line-opacity": byTier(TIER_OPACITY),
      },
    },
    {
      ...common,
      id: "overview-corridors-brand",
      type: "line",
      "source-layer": OVERVIEW_LAYERS.corridors,
      filter: hasColor,
      paint: {
        "line-color": ["get", "color"],
        "line-width": widths(BRAND_WIDTHS),
      },
    },
    {
      ...common,
      id: "overview-routes",
      type: "line",
      "source-layer": OVERVIEW_LAYERS.routes,
      filter: ["all", hasColor, ["!", kind("skytrain")]],
      paint: {
        "line-color": ["get", "color"],
        "line-width": widths(BRAND_WIDTHS),
      },
    },
    {
      ...common,
      id: "overview-skytrain",
      type: "line",
      "source-layer": OVERVIEW_LAYERS.routes,
      filter: kind("skytrain"),
      paint: {
        "line-color": ["get", "color"],
        "line-width": widths(SKYTRAIN_WIDTHS),
      },
    },
  ];
}
