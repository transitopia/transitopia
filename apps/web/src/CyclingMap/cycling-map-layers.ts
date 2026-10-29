// Transitopia Cycling map style for MapLibre GL
// By Braden MacDonald
// Code license: MIT (see repository's LICENSE file)
// Design license: CC-BY 4.0 https://creativecommons.org/licenses/by/4.0/

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import { CYCLING_LAYER } from "@transitopia/cycling-core/tiles.ts";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { FONTS } from "@transitopia/map-style/basemap.ts";
import {
  defaultLineLayout,
  interpolateZoom,
} from "@transitopia/map-style/zoom.ts";

// Which map "source" file (which .pmtiles file) the cycling data layers are found in
export const mapSource = "transitopia-cycling";

/** Layers with cycling paths, as opposed to other things like bike rack locations */
export const pathLayerIds = [
  "cycling_path_1",
  "cycling_path_2",
  "cycling_path_3",
  "cycling_path_4",
  "cycling_path_construction",
];
export const otherLayerIds = ["bike_parking_point"];

/**
 * What the cycling layers panel shows (CyclingLayers.tsx). The categories follow the tiles' comfort
 * levels (packages/cycling-core/src/classify.ts): protected = separated
 * tracks and paths (comfort 4, or 3 when shared with pedestrians), local = traffic-calmed shared
 * streets (comfort 3 on the road), painted = lanes on the roadway, including shared lanes on busy
 * streets (comfort 1–2). "All ages & abilities only" hides comfort 1–2 whatever `painted` says.
 */
export interface CyclingShow {
  protected: boolean;
  painted: boolean;
  local: boolean;
  parking: boolean;
  construction: boolean;
  aaaOnly: boolean;
}

export const DEFAULT_SHOW: CyclingShow = {
  protected: true,
  painted: true,
  local: true,
  parking: true,
  construction: true,
  aaaOnly: false,
};

const comfort: ExpressionSpecification = ["to-number", ["get", "comfort"]];
const isLine: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
const notConstruction: ExpressionSpecification = [
  "!=",
  ["get", "construction"],
  true,
];

/** Paths (not under construction) in a category the panel shows. */
function shownPaths(show: CyclingShow): ExpressionSpecification {
  const any: ExpressionSpecification[] = [];
  if (show.protected)
    any.push([
      "any",
      ["==", comfort, 4],
      ["all", ["==", comfort, 3], ["==", ["get", "class"], "track"]],
    ]);
  if (show.local)
    any.push(["all", ["==", comfort, 3], ["!=", ["get", "class"], "track"]]);
  if (show.painted && !show.aaaOnly) any.push(["<=", comfort, 2]);
  return ["any", ...any];
}

/** Each layer's filter for what the panel shows. */
export function cyclingFilters(
  show: CyclingShow,
): Record<string, ExpressionSpecification> {
  const paths = shownPaths(show);
  const level = (n: number): ExpressionSpecification => [
    "all",
    isLine,
    ["==", comfort, n],
    notConstruction,
    paths,
  ];
  const oneway: ExpressionSpecification = [
    "any",
    ["==", ["get", "oneway"], 1],
    ["==", ["get", "oneway"], -1],
  ];
  return {
    cycling_path_construction: [
      "all",
      isLine,
      ["==", ["get", "construction"], true],
      show.construction,
    ],
    cycling_path_4: level(4),
    cycling_path_3: level(3),
    cycling_path_3_inner: level(3),
    cycling_path_2: level(2),
    cycling_path_1: level(1),
    cycling_path_oneway_arrows_white: [
      "all",
      isLine,
      oneway,
      [">=", comfort, 3],
      notConstruction,
      paths,
    ],
    cycling_path_oneway_arrows_green: [
      "all",
      isLine,
      oneway,
      ["<=", comfort, 2],
      notConstruction,
      paths,
    ],
    cycling_path_name: [
      "all",
      isLine,
      ["in", ["get", "class"], ["literal", ["track", "lane"]]],
      ["has", "name"],
      [">=", comfort, 2],
      paths,
    ],
    bike_parking_point: [
      "all",
      ["==", ["geometry-type"], "Point"],
      ["==", ["get", "amenity"], "bicycle_parking"],
      show.parking,
    ],
  };
}

/** The global state property naming the selected bike route's relation id (null for none). */
export const SELECTED_ROUTE = "cyclingSelectedRoute";

/**
 * On the selected bike route: its id is one of a path's `routes` (comma-separated). Paths have
 * routes only from CYCLING_DETAIL_ZOOM.
 */
const onSelectedRoute: ExpressionSpecification = [
  "in",
  ["concat", ",", ["coalesce", ["global-state", SELECTED_ROUTE], "none"], ","],
  ["concat", ",", ["coalesce", ["get", "routes"], ""], ","],
];

/**
 * Helper: the resulting color should normally be 'color',
 * but make it salmon colored when hovered or selected, or on the selected route.
 */
const colorWithHoverAndSelectionStates = (color: string) =>
  [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    "rgba(200, 100, 100, 1)",
    ["boolean", ["feature-state", "hover"], false],
    "rgba(200, 100, 100, 1)",
    onSelectedRoute,
    "rgba(200, 100, 100, 1)",
    color,
  ] satisfies ExpressionSpecification;

/** Colours per theme. Light is the original design; dark keeps the same meaning on a dark basemap. */
const PALETTE = {
  light: {
    path: "rgba(26, 109, 35, 1)",
    pathLeastComfortable: "rgba(26, 50, 35, 1)",
    pathInner: "rgba(255, 255, 255, 0.6)",
    construction: "rgba(226, 109, 35, 1)",
    name: "rgba(24, 79, 19, 1)",
    nameHalo: "rgba(231, 231, 131, 0.72)",
    parkingFill: "rgba(231, 231, 131, 0.72)",
  },
  dark: {
    path: "rgba(76, 194, 106, 1)",
    pathLeastComfortable: "rgba(167, 201, 174, 1)",
    pathInner: "rgba(21, 24, 28, 0.7)",
    construction: "rgba(240, 138, 60, 1)",
    name: "rgba(184, 240, 194, 1)",
    nameHalo: "rgba(21, 24, 28, 0.85)",
    parkingFill: "rgba(70, 80, 40, 0.9)",
  },
} satisfies Record<Theme, Record<string, string>>;

export function cyclingLayers(
  theme: Theme,
  show: CyclingShow,
): LayerSpecification[] {
  const c = PALETTE[theme];
  const filters = cyclingFilters(show);
  const layers: LayerSpecification[] = [
    {
      id: "cycling_path_construction",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: {
        "line-cap": "butt",
        "line-join": "bevel",
        visibility: "visible",
      },
      paint: {
        "line-color": colorWithHoverAndSelectionStates(c.construction),
        "line-width": interpolateZoom({ z10: 3, z16: 4 }),
        "line-dasharray": [0.4, 1],
      },
    },
    {
      id: "cycling_path_4",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: defaultLineLayout,
      paint: {
        "line-color": colorWithHoverAndSelectionStates(c.path),
        "line-width": interpolateZoom({ z10: 2, z16: 8 }),
      },
    },
    {
      id: "cycling_path_3",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: defaultLineLayout,
      paint: {
        "line-color": colorWithHoverAndSelectionStates(c.path),
        "line-width": interpolateZoom({ z10: 2, z16: 7 }),
      },
    },
    {
      // Draw white centre lines overtop of "comfort level 3" cycling paths
      id: "cycling_path_3_inner",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      minzoom: 13,
      layout: defaultLineLayout,
      paint: {
        "line-color": c.pathInner,
        "line-width": 2,
        "line-dasharray": [2, 4],
      },
    },
    {
      id: "cycling_path_2",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: defaultLineLayout,
      paint: {
        "line-color": colorWithHoverAndSelectionStates(c.path),
        "line-width": interpolateZoom({ z10: 3, z16: 6 }),
        // dashed lines when zoomed in greater than 12
        "line-dasharray": {
          type: "interval",
          stops: [
            [0, [1]],
            [12, [0.4, 1.4]],
          ],
        },
      },
    },
    {
      id: "cycling_path_1",
      type: "line",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      minzoom: 8,
      layout: defaultLineLayout,
      paint: {
        "line-color": colorWithHoverAndSelectionStates(c.pathLeastComfortable),
        "line-width": interpolateZoom({ z10: 2, z16: 4 }),
        "line-dasharray": [0.3, 2],
      },
    },
    {
      id: "cycling_path_oneway_arrows_white",
      type: "symbol",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      minzoom: 8,
      paint: {
        "icon-opacity": interpolateZoom({ z1: 0, z14: 0, z15: 0.9 }),
      },
      layout: {
        "icon-image": "transitopia:chevron-white",
        "icon-rotate": 90,
        "icon-size": 0.6,
        "icon-allow-overlap": true,
        visibility: "visible",
        "symbol-spacing": 40,
        "symbol-placement": "line",
      },
    },
    {
      id: "cycling_path_oneway_arrows_green",
      type: "symbol",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      minzoom: 8,
      paint: {
        "icon-opacity": interpolateZoom({ z1: 0, z14: 0, z15: 0.9 }),
      },
      layout: {
        "icon-image": "transitopia:chevron-green",
        // Rotate the icon 90° for the common case, one way in the direction of the street.
        // Rotate it 270° for the rare case, one way in the opposite direction of the street
        "icon-rotate": ["case", ["==", ["get", "oneway"], 1], 90, 270],
        "icon-size": 0.8,
        "icon-allow-overlap": true,
        visibility: "visible",
        "symbol-spacing": 40,
        "symbol-placement": "line",
      },
    },
    {
      id: "cycling_path_name",
      type: "symbol",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 350,
        "text-field": "{name}",
        "text-font": [...FONTS.regular],
        "text-max-angle": 30,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "map",
        "text-offset": [0, 1.1],
        "text-size": 10,
        "text-transform": "uppercase",
        visibility: "visible",
      },
      paint: {
        "text-color": c.name,
        "text-halo-blur": 1,
        "text-halo-color": c.nameHalo,
        "text-halo-width": 2,
      },
    },
    // Bike parking (points)
    {
      id: "bike_parking_point",
      type: "circle",
      source: mapSource,
      "source-layer": CYCLING_LAYER,
      layout: {
        visibility: "visible",
        "circle-sort-key": 1,
      },
      paint: {
        "circle-radius": interpolateZoom({ z8: 1, z12: 1, z16: 3 }),
        "circle-color": c.parkingFill,
        "circle-stroke-width": interpolateZoom({ z8: 0.5, z12: 0.5, z16: 2 }),
        "circle-stroke-color": colorWithHoverAndSelectionStates(c.path),
        "circle-stroke-opacity": interpolateZoom({
          z12: 0,
          z14: 0.5,
          z16: 0.8,
        }),
      },
    },
  ];
  // Every layer here is a vector layer with an entry in cyclingFilters.
  return layers.map(
    (l) => ({ ...l, filter: filters[l.id]! }) as LayerSpecification,
  );
}
