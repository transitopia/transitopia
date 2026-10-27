// SkyTrain track layers from the infrastructure model (packages/transit-map/README.md#rendering). Below
// RIBBON_ZOOM each line is a stroke along its centreline (both tracks of a pair as one line, split
// lengthwise in both lines' colours where they share track); from it, a ribbon the guideway's true
// width, one polygon per line, with the tracks as white hairlines inside, fading to half opacity close
// in so bus stops and streets under or over the guideway show. Both are in the plan's tiles
// (packages/transit-core/DESIGN.md#plan-tiles), from lines.geojson (packages/transit-core/src/infra/line-geometry.ts),
// which also splits the track into service track and the rest: yards, tail tracks, spurs and track
// past the last platform are grey; track OSM marks as under works is dashed. With ?debug=1: segment
// ids, node kinds and mapped GTFS platforms, from the track network itself.

import type { FeatureCollection } from "geojson";
import type {
  GeoJSONSource,
  LineLayerSpecification,
  Map as MlMap,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import {
  feedDataPath,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import { PLAN_TILE_LAYERS } from "@transitopia/transit-core/plan/tiles.ts";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import {
  casingOpacity,
  DIM_OPACITY,
  focusColor,
  FOCUS_LAYERS_START,
  LINES_SOURCE,
  onFocus,
  routeLineColor,
  VEHICLES_BEFORE_LAYER,
} from "./static.ts";

/** The track network, drawn only with ?debug=1. */
export const TRACKS_SOURCE = "tracks";
const TRACK_LAYERS = [
  "tracks-yard",
  "tracks-other",
  "rail-casing",
  "tracks-minor",
  "rail-centre",
  "rail-shared",
  "rail-centre-focus",
  "rail-shared-focus",
  "rail-ribbon",
  "tracks-works",
  "tracks-hairline",
  "tracks-focus",
];
/** SkyTrain layers a tap on the map can pick a line from. */
export const PICKABLE_TRACK_LAYERS = [
  "rail-centre",
  "rail-shared",
  "rail-ribbon",
];
/** From this zoom the line is its ribbon (true width), below it a stroke: where the two are as wide. */
export const RIBBON_ZOOM = 15.3;
/** Each track layer's own filter, so line visibility can be combined with it. */
const baseFilters = new Map<string, ExpressionSpecification>();
export const DEBUG_SOURCE = "tracks-debug";

export interface PlatformsFile {
  feedVersion: string;
  platforms: Record<
    string,
    { seg: string; offset: number; dist: number; method: string }
  >;
}

/** The URL of a published file, by its path (PlanStore.dataUrl). */
type DataUrl = (path: string) => string;

export async function loadTracks(
  url: DataUrl,
  path: string,
): Promise<InfraCollection | undefined> {
  try {
    const res = await fetch(url(path));
    return res.ok ? ((await res.json()) as InfraCollection) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPlatforms(
  url: DataUrl,
  feed: string,
  feedVersion: string,
): Promise<PlatformsFile | undefined> {
  try {
    const res = await fetch(
      url(feedDataPath(feed, feedVersion, "platforms.json")),
    );
    return res.ok ? ((await res.json()) as PlatformsFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Mark SkyTrain line pieces (feature ids in the plan's tiles) as on a combined route's stretch, or not. */
export function setRailFocus(
  map: MlMap,
  ids: Iterable<number>,
  focus: boolean,
): void {
  if (!map.getSource(LINES_SOURCE)) return;
  for (const id of ids)
    map.setFeatureState(
      { source: LINES_SOURCE, sourceLayer: PLAN_TILE_LAYERS.railLines, id },
      { focus },
    );
}

/** SkyTrain's layers, drawn from the plan's tiles (none there in a region without track-level rail). */
export function addTrackLayers(
  map: MlMap,
  plan: ServicePlan,
  theme: Theme,
): void {
  if (map.getLayer("rail-centre")) return;
  const dark = theme === "dark";
  const yard = dark ? "#5b636d" : "#a9b0b8";
  const casing = dark ? "#15181c" : "#ffffff";
  // Above bus stop ticks, so zoomed out the line hides stops under or over the guideway; they show
  // through once it fades close in. Below the focused bus route (its card is open), exchanges,
  // stations and labels.
  const before =
    map.getLayer(VEHICLES_BEFORE_LAYER) && map.getLayer(FOCUS_LAYERS_START) ?
      FOCUS_LAYERS_START
    : undefined;
  const lines = {
    source: LINES_SOURCE,
    "source-layer": PLAN_TILE_LAYERS.railLines,
  } as const;
  const segments = {
    source: LINES_SOURCE,
    "source-layer": PLAN_TILE_LAYERS.railTracks,
  } as const;
  /**
   * A line's colour (its frequency colour while routes are coloured by frequency), grey where none
   * runs (yards, track off every line).
   */
  const ownColor = routeLineColor("line", ["coalesce", ["get", "color"], yard]);

  baseFilters.clear();
  const kind = (...k: string[]) =>
    ["in", ["get", "kind"], ["literal", k]] as ExpressionSpecification;
  const width = (lo: number, mid: number, hi: number) =>
    [
      "interpolate",
      ["exponential", 1.6],
      ["zoom"],
      10,
      lo,
      14,
      mid,
      18,
      hi,
    ] as ExpressionSpecification;
  const centre = ["==", ["get", "type"], "centre"] as ExpressionSpecification;
  const track = (service: boolean) =>
    [
      "all",
      ["==", ["get", "type"], "track"],
      ["==", ["get", "service"], service],
    ] as ExpressionSpecification;
  const shared = ["get", "shared"] as ExpressionSpecification;
  /** The stroke's width below RIBBON_ZOOM (px): thicker than any bus corridor. */
  const STROKE: [number, number][] = [
    [10, 3],
    [12, 4.5],
    [14, 6.5],
    [RIBBON_ZOOM, 7.2],
  ];
  const stroke = (scale: number, extra = 0) =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...STROKE.flatMap(([z, w]) => [z, w * scale + extra]),
    ] as ExpressionSpecification;
  const low = { maxzoom: RIBBON_ZOOM };
  // A combined route's stretch (packages/transit-map/README.md#route-focus): its line pieces have
  // the feature state `focus` (setRailFocus), and copies of the layers drawing them, on top, show
  // them in their own colour; elsewhere these are zero wide. The same filters and layout as the
  // layers beneath, so MapLibre builds one set of buffers for both.
  const focused: ExpressionSpecification = [
    "boolean",
    ["feature-state", "focus"],
    false,
  ];
  /** Zoom stops' widths, zero off the focus with `only`. */
  const stops = (
    values: [number, ExpressionSpecification | number][],
    only?: boolean,
  ) =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...values.flatMap(([z, w]) => [z, only ? ["case", focused, w, 0] : w]),
    ] as ExpressionSpecification;
  // Off the focused route (its card is open), lines are faded (static.ts → setFocusRoute): strokes
  // by colour, since their pieces overlap; the ribbon, one polygon per line, by opacity.
  const lineColor = focusColor(plan.routes, theme, "line", [
    "coalesce",
    ["get", "color"],
    yard,
  ]);
  const dimmed = (x: number) =>
    ["case", onFocus("line"), x, x * DIM_OPACITY] as ExpressionSpecification;

  map.addLayer(
    {
      id: "tracks-yard",
      type: "line",
      ...segments,
      minzoom: 12,
      filter: kind("yard"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": yard, "line-width": width(0.5, 1, 3) },
    },
    before,
  );
  // Tail tracks, spurs and track past the last platform: drawn like yard track.
  map.addLayer(
    {
      id: "tracks-other",
      type: "line",
      ...lines,
      minzoom: 12,
      filter: track(false),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": yard, "line-width": width(0.5, 1, 3) },
    },
    before,
  );
  map.addLayer(
    {
      id: "rail-casing",
      type: "line",
      ...lines,
      ...low,
      filter: centre,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": casing,
        "line-width": stroke(1, 3),
        "line-opacity": casingOpacity(onFocus("line")),
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "tracks-minor",
      type: "line",
      ...lines,
      minzoom: 12.5,
      ...low,
      filter: ["all", track(true), ["!=", ["get", "kind"], "main"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": lineColor,
        "line-width": width(0.8, 1.5, 3.5),
        "line-opacity": 0.9,
      },
    },
    before,
  );
  const centreStroke: Omit<LineLayerSpecification, "id" | "paint"> = {
    type: "line",
    ...lines,
    ...low,
    filter: ["all", centre, ["!", shared]],
    layout: { "line-cap": "round", "line-join": "round" },
  };
  map.addLayer(
    {
      id: "rail-centre",
      ...centreStroke,
      paint: { "line-color": lineColor, "line-width": stroke(1) },
    },
    before,
  );
  // Shared track: one stroke per line along the stretch's spine, side by side, the first line on
  // the left of west to east (stripe 0 of `stripes`).
  const stripes = ["get", "stripes"] as ExpressionSpecification;
  const sharedStroke: Omit<LineLayerSpecification, "id" | "paint"> = {
    type: "line",
    ...lines,
    ...low,
    filter: ["all", centre, shared],
    layout: { "line-join": "round" },
  };
  const stripeWidth = (only?: boolean) =>
    stops(
      STROKE.map(([z, w]) => [z, ["/", w, stripes] as ExpressionSpecification]),
      only,
    );
  const stripeOffset: ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...STROKE.flatMap(([z, w]) => [
      z,
      ["*", w, ["-", ["/", ["+", ["get", "stripe"], 0.5], stripes], 0.5]],
    ]),
  ] as ExpressionSpecification;
  map.addLayer(
    {
      id: "rail-shared",
      ...sharedStroke,
      paint: {
        "line-color": lineColor,
        "line-width": stripeWidth(),
        "line-offset": stripeOffset,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "rail-centre-focus",
      ...centreStroke,
      paint: {
        "line-color": ownColor,
        "line-width": stops(STROKE, true),
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "rail-shared-focus",
      ...sharedStroke,
      paint: {
        "line-color": ownColor,
        "line-width": stripeWidth(true),
        "line-offset": stripeOffset,
      },
    },
    before,
  );
  // Close in: the ribbon, one polygon per line, so it fades evenly.
  map.addLayer(
    {
      id: "rail-ribbon",
      type: "fill",
      ...lines,
      minzoom: RIBBON_ZOOM,
      filter: ["==", ["get", "type"], "ribbon"],
      paint: {
        "fill-color": ownColor,
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16,
          dimmed(1),
          17,
          dimmed(0.5),
        ],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "tracks-works",
      type: "line",
      ...segments,
      filter: ["has", "works"],
      paint: {
        "line-color": lineColor,
        "line-width": width(2, 3, 4),
        "line-dasharray": [2, 1],
      },
    },
    before,
  );
  // The tracks themselves inside the ribbon.
  map.addLayer(
    {
      id: "tracks-hairline",
      type: "line",
      ...lines,
      minzoom: RIBBON_ZOOM,
      filter: track(true),
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          15.5,
          0.7,
          17,
          1.3,
          19,
          2,
        ],
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          RIBBON_ZOOM,
          0,
          16,
          dimmed(1),
          17,
          dimmed(0.6),
        ],
      },
    },
    before,
  );
  // Close in, the stretch's tracks in their line's colour over its faded ribbon.
  map.addLayer(
    {
      id: "tracks-focus",
      type: "line",
      ...lines,
      minzoom: RIBBON_ZOOM,
      filter: track(true),
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ownColor,
        "line-width": stops(
          [
            [15.5, 3],
            [17, 5],
            [19, 8],
          ],
          true,
        ),
      },
    },
    before,
  );
  for (const id of TRACK_LAYERS) {
    const f = map.getFilter(id);
    if (f) baseFilters.set(id, f as ExpressionSpecification);
  }
}

/** ?debug=1: the track network's nodes and segment ids, and where GTFS platforms were mapped. */
export function addTrackDebugLayers(
  map: MlMap,
  tracks: InfraCollection,
  theme: Theme,
): void {
  if (map.getSource(TRACKS_SOURCE)) return;
  const dark = theme === "dark";
  const casing = dark ? "#15181c" : "#ffffff";
  const seg = ["==", ["get", "type"], "segment"] as ExpressionSpecification;
  map.addSource(TRACKS_SOURCE, {
    type: "geojson",
    data: tracks as FeatureCollection,
  });
  map.addLayer({
    id: "tracks-nodes",
    type: "circle",
    source: TRACKS_SOURCE,
    minzoom: 15,
    filter: [
      "all",
      ["==", ["get", "type"], "node"],
      [
        "in",
        ["get", "kind"],
        ["literal", ["switch", "buffer", "end", "crossing"]],
      ],
    ],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 1.5, 18, 4],
      "circle-color": [
        "match",
        ["get", "kind"],
        "switch",
        dark ? "#e6e8eb" : "#1f2328",
        "crossing",
        "#8e5ac8",
        "#d92d20",
      ],
      "circle-stroke-width": 1,
      "circle-stroke-color": casing,
    },
  });

  map.addSource(DEBUG_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "debug-seg-labels",
    type: "symbol",
    source: TRACKS_SOURCE,
    minzoom: 16,
    filter: seg,
    layout: {
      "symbol-placement": "line",
      "text-field": ["concat", ["get", "id"], " ", ["get", "kind"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
    },
    paint: {
      "text-color": dark ? "#e6e8eb" : "#333",
      "text-halo-color": casing,
      "text-halo-width": 1.5,
    },
  });
  map.addLayer({
    id: "debug-platforms",
    type: "symbol",
    source: DEBUG_SOURCE,
    minzoom: 15,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Medium"],
      "text-size": 11,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#d92d20",
      "text-halo-color": casing,
      "text-halo-width": 2,
    },
  });
}

/** Debug overlay: where each GTFS platform was mapped onto the tracks. */
export function setDebugPlatforms(
  map: MlMap,
  g: TrackGraph,
  plan: ServicePlan,
  platforms: PlatformsFile,
): void {
  const src = map.getSource(DEBUG_SOURCE) as GeoJSONSource | undefined;
  if (!src) return;
  const features: GeoJSON.Feature[] = [];
  for (const [stopId, p] of Object.entries(platforms.platforms)) {
    const stop = plan.stops.find((s) => s.id === stopId);
    if (!stop || !g.segments.has(p.seg)) continue;
    const at = g.pointAt({ seg: p.seg, offset: p.offset });
    features.push({
      type: "Feature",
      properties: {
        label: `${stop.platform ? `P${stop.platform}` : "·"} ${stop.id}`,
        method: p.method,
      },
      geometry: { type: "Point", coordinates: [at.lon, at.lat] },
    });
  }
  void src.setData({ type: "FeatureCollection", features });
}

/** Hide tracks of hidden lines (yards stay visible). */
export function applyTrackFilter(
  map: MlMap,
  hidden: ReadonlySet<string>,
): void {
  const lineVisible: ExpressionSpecification = [
    "!",
    ["in", ["get", "line"], ["literal", [...hidden]]],
  ];
  for (const id of TRACK_LAYERS) {
    const base = baseFilters.get(id);
    if (map.getLayer(id) && base) map.setFilter(id, ["all", base, lineVisible]);
  }
}
