// Static transit layers drawn by MapLibre: route lines and bus corridors coloured by how often buses
// pass (packages/transit-map/README.md#bus-corridors), styled from the plan's tiles
// (packages/transit-core/DESIGN.md#plan-tiles), and stations, bus exchanges and bus stops, drawn from the
// plan as GeoJSON.

import type { FeatureCollection } from "geojson";
import type {
  GeoJSONSource,
  LineLayerSpecification,
  Map as MlMap,
  SymbolLayerSpecification,
} from "maplibre-gl";
import type {
  ExpressionSpecification,
  GeoJSONSourceSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import type {
  PlanRoute,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import {
  brandedRoutes,
  CORRIDOR_DETAIL_ZOOM,
  drawsCorridors,
  PLAN_TILE_LAYERS,
} from "@transitopia/transit-core/plan/tiles.ts";
import {
  busStopMarkers,
  busStopTicks,
} from "@transitopia/transit-core/plan/bus-stops.ts";
import { BACKGROUND, type Theme } from "@transitopia/map-style/basemap.ts";
import { FREQUENCY_BANDS, NO_SERVICE } from "@transitopia/shared/frequency.ts";
import { hubsOf } from "../plans.ts";
import { SHOW_BRAND_COLORS } from "../overview.ts";
import { hexToRgb } from "./vehicle-geometry.ts";

/** The plan's tiles: every line drawn (PLAN_TILE_LAYERS). */
export const LINES_SOURCE = "transit-lines";
export const STATIONS_SOURCE = "transit-stations";
export const EXCHANGES_SOURCE = "transit-exchanges";
export const BUS_STOPS_SOURCE = "transit-bus-stops";
export const BUS_TICKS_SOURCE = "transit-bus-stop-ticks";
const TICK_IMAGE = "bus-stop-tick";
/** Text anchor for a label placed in each compass direction (N, NE, E, …) from its point. */
const ANCHORS = [
  "bottom",
  "bottom-left",
  "left",
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
];
/** Vehicles are inserted beneath this layer, so stop and station labels stay readable above them. */
export const VEHICLES_BEFORE_LAYER = "bus-stops-label";
/** The first of the focused route's layers, drawn over SkyTrain's (addTrackLayers goes beneath it). */
export const FOCUS_LAYERS_START = "corridors-overview-focus-casing";
export const SELECTED_PLACE_SOURCE = "transit-selected-place";
/** The ring around a selected place (px); also how far a tap looks for what it might mean. */
export const SELECTED_PLACE_RADIUS_PX = 20;
const SELECTED_PLACE_LAYER = "selected-place";

const BUS_FREQUENT: ExpressionSpecification = [
  "all",
  ["==", ["get", "kind"], "bus"],
  ["!", ["get", "limited"]],
];
const BUS_LIMITED: ExpressionSpecification = [
  "all",
  ["==", ["get", "kind"], "bus"],
  ["get", "limited"],
];
/** Map global state: the ferry berth pair in use on the day shown (see setFerryPair). */
const FERRY_PAIR = "ferryPair";
/** Shape routes, except a ferry's berth pair that isn't in use that day (drawn dotted instead). */
const SHAPE_ACTIVE: ExpressionSpecification = [
  "all",
  ["==", ["get", "kind"], "shape"],
  [
    "any",
    ["!", ["has", "berthPair"]],
    ["==", ["get", "berthPair"], ["global-state", FERRY_PAIR]],
  ],
];
const SHAPE_INACTIVE: ExpressionSpecification = [
  "all",
  ["==", ["get", "kind"], "shape"],
  ["has", "berthPair"],
  ["!=", ["get", "berthPair"], ["global-state", FERRY_PAIR]],
];

/**
 * Map global state: the route whose card is open, or null. Every other route is drawn at
 * DIM_OPACITY of its usual opacity (packages/transit-map/README.md#route-focus).
 */
const FOCUS_ROUTE = "focusRoute";
export const DIM_OPACITY = 0.2;
const focusKey = [
  "coalesce",
  ["global-state", FOCUS_ROUTE],
  "",
] as ExpressionSpecification;
/** True where a feature's route (`prop`) is the focused one, or nothing is focused. */
export const onFocus = (prop = "route"): ExpressionSpecification => [
  "any",
  ["==", focusKey, ""],
  ["==", ["get", prop], focusKey],
];
/**
 * Map global state while a combined route is focused: its stops' ids (",50123,50124,"). The focused
 * route is then SEGMENT_FOCUS, which no route has, so every route line is dimmed; its corridors are
 * kept by feature state (BusFrequencyLayer).
 */
const FOCUS_STOPS = "focusStops";
export const SEGMENT_FOCUS = "*segment";
/**
 * True where the focused route stops (a stop's `routes`, ",99,R4,"), where a focused combined route
 * stops, or where nothing is focused.
 */
const stopOnFocus: ExpressionSpecification = [
  "any",
  ["==", focusKey, ""],
  ["in", ["concat", ",", focusKey, ","], ["get", "routes"]],
  [
    "in",
    ["concat", ",", ["to-string", ["get", "stop"]], ","],
    ["coalesce", ["global-state", FOCUS_STOPS], ""],
  ],
];
/**
 * Map global states while every route is coloured by frequency (the viewer turned brand colours
 * off, `setRouteColors`): per route key, the colour its lines are drawn in, and the colour off the
 * focused route; null while routes are drawn in their own colours.
 */
const ROUTE_COLORS = "routeColors";
const ROUTE_FADED = "routeFaded";
/** The colour ROUTE_COLORS or ROUTE_FADED (`state`) gives the feature's route (`prop`), else `own`. */
const colorOverride = (
  state: string,
  prop: string,
  own: ExpressionSpecification,
): ExpressionSpecification => [
  "coalesce",
  [
    "get",
    ["to-string", ["get", prop]],
    ["object", ["global-state", state], ["literal", {}]],
  ],
  own,
];
/** A line's colour: its route's own (`color`), or its frequency colour while routes are coloured by frequency. */
export const routeLineColor = (
  prop = "route",
  own: ExpressionSpecification = ["get", "color"],
): ExpressionSpecification => colorOverride(ROUTE_COLORS, prop, own);

/**
 * Colour every route by frequency (`colors`: per route key, its colour; `faded`, off the focused
 * route), or with none, in their own colours.
 */
export function setRouteColors(
  map: MlMap,
  colors: Record<string, string> | undefined,
  faded: Record<string, string> | undefined,
): void {
  map.setGlobalStateProperty(ROUTE_COLORS, colors ?? null);
  map.setGlobalStateProperty(ROUTE_FADED, faded ?? null);
}

/**
 * Whether bus routes with their own colour are drawn in it along corridors (overview.ts →
 * SHOW_BRAND_COLORS: the viewer's choice), or corridors and stop ticks show only frequency tiers.
 */
const brandShown: ExpressionSpecification = [
  "boolean",
  ["coalesce", ["global-state", SHOW_BRAND_COLORS], true],
  true,
];

/** An opacity, dimmed off the focused route (for symbols, which don't overlap themselves). */
export const focusOpacity = (
  base: number,
  on: ExpressionSpecification = onFocus(),
): ExpressionSpecification => ["case", on, base, base * DIM_OPACITY];
/** A casing's opacity: none off the focused route. */
export const casingOpacity = (
  on: ExpressionSpecification = onFocus(),
): ExpressionSpecification => ["case", on, 1, 0];

/**
 * A colour as it looks at DIM_OPACITY over the land, but opaque. Lines are dimmed by colour, not
 * opacity: where a line's pieces overlap (joins, switches, branches), translucent ones would show
 * darker dots.
 */
export function fadeColor(hex: string, theme: Theme): string {
  const c = hexToRgb(hex);
  const bg = hexToRgb(BACKGROUND[theme]);
  const mix = c.map((v, i) =>
    Math.round(v * DIM_OPACITY + bg[i]! * (1 - DIM_OPACITY)),
  );
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A route's colour (`routeLineColor`: its own, `color` or `own`, unless routes are coloured by
 * frequency), faded off the focused route; `prop` names the route.
 */
export function focusColor(
  routes: readonly { key: string; color: string }[],
  theme: Theme,
  prop = "route",
  own: ExpressionSpecification = ["get", "color"],
): ExpressionSpecification {
  const color = routeLineColor(prop, own);
  if (!routes.length) return color;
  return [
    "case",
    onFocus(prop),
    color,
    colorOverride(ROUTE_FADED, prop, [
      "match",
      ["get", prop],
      ...routes.flatMap((r) => [r.key, fadeColor(r.color, theme)]),
      color,
    ] as unknown as ExpressionSpecification),
  ] as unknown as ExpressionSpecification;
}

/** Corridors are dimmed by feature state (BusFrequencyLayer knows which carry the route). */
const corridorDim: ExpressionSpecification = [
  "boolean",
  ["feature-state", "dim"],
  false,
];
/** Whether a route or combined route is focused (its card is open). */
const focusSet: ExpressionSpecification = ["!=", focusKey, ""];
/** A corridor carrying the focused route (its card is open). */
const corridorFocused: ExpressionSpecification = [
  "all",
  focusSet,
  ["!", corridorDim],
];
/** A corridor whose routes don't run in the window shown (BusFrequencyLayer). */
const corridorIdle: ExpressionSpecification = [
  "boolean",
  ["feature-state", "idle"],
  false,
];
const corridorCasingOpacity: ExpressionSpecification = [
  "case",
  corridorDim,
  0,
  1,
];

/**
 * Focus the map on one route (its card is open), or a combined route (its stops' ids), dimming
 * the rest, or on none.
 */
export function setFocus(
  map: MlMap,
  focus: { route: string } | { stops: readonly string[] } | undefined,
): void {
  map.setGlobalStateProperty(
    FOCUS_ROUTE,
    !focus ? null
    : "route" in focus ? focus.route
    : SEGMENT_FOCUS,
  );
  map.setGlobalStateProperty(
    FOCUS_STOPS,
    focus && "stops" in focus ? `,${focus.stops.join(",")},` : null,
  );
}

/** Frequency tier colours, every 6 min or better first (packages/transit-map/README.md#bus-corridors). */
const TIER_COLORS = {
  light: FREQUENCY_BANDS.map((b) => b.color.light),
  dark: FREQUENCY_BANDS.map((b) => b.color.dark),
};
/** Corridor widths per tier at a few zooms. */
const TIER_WIDTHS: [number, number[]][] = [
  [10, [2.4, 1.5, 1, 0.6]],
  [13, [5, 3.4, 2.2, 1]],
  [15, [7, 5, 3, 1.4]],
  [17, [10, 7, 4, 1.8]],
];
/**
 * Corridor opacity per tier: Bad recedes, so worse service is always less prominent (except on the
 * focused route).
 */
const TIER_OPACITY = [1, 1, 1, 0.7];
const TIER = [
  "coalesce",
  ["feature-state", "tier"],
  -1,
] as ExpressionSpecification;
const BRAND = [
  "coalesce",
  ["feature-state", "brand"],
  -1,
] as ExpressionSpecification;
/** Widths of routes with their own colour (cased): thicker than the most frequent tier, which they cover. */
const BRAND_WIDTHS: [number, number][] = [
  [10, 2.8],
  [13, 5.4],
  [15, 7.6],
  [17, 10.8],
];

/** A value per frequency tier (feature state), or `none` without service. */
function byTier<T extends string | number>(
  values: T[],
  none: T | ExpressionSpecification,
): ExpressionSpecification {
  return [
    "match",
    TIER,
    0,
    values[0]!,
    1,
    values[1]!,
    2,
    values[2]!,
    3,
    values[3]!,
    none,
  ] as ExpressionSpecification;
}

function busStopsGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: busStopMarkers(plan).map((s) => ({
      type: "Feature" as const,
      properties: {
        name: s.name,
        stop: s.stop,
        // ",99,R4," so filters can test membership with a substring match.
        routes: `,${s.routes.join(",")},`,
        n: s.routes.length,
        // Text anchor opposite the tick's direction, so the label sits beyond the tick's end.
        anchor: ANCHORS[Math.round(s.bearing / 45) % 8],
      },
      geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
    })),
  };
}

/**
 * Bus stop ticks. With corridors, one per stop (its id the stop's index in the plan, for its
 * frequency's feature state), coloured by how often buses stop there unless only routes drawn on
 * their own serve it; without, one per stop and route, in the route's colour.
 */
function busTicksGeoJson(plan: ServicePlan): FeatureCollection {
  const color = new Map(plan.routes.map((r) => [r.key, r.color]));
  const ticks = busStopTicks(plan);
  if (!drawsCorridors(plan))
    return {
      type: "FeatureCollection",
      features: ticks.map((t) => ({
        type: "Feature" as const,
        properties: {
          route: t.route,
          routes: `,${t.route},`,
          n: 1,
          stop: t.stop,
          bearing: t.bearing,
          color: color.get(t.route) ?? "#888",
        },
        geometry: { type: "Point" as const, coordinates: [t.lon, t.lat] },
      })),
    };
  const corridor = new Set(
    plan.routes.filter((r) => r.kind === "bus").map((r) => r.key),
  );
  const index = stopIndex(plan);
  const byStop = new Map<
    string,
    { tick: (typeof ticks)[number]; routes: Set<string> }
  >();
  for (const t of ticks) {
    const g = byStop.get(t.stop);
    if (g) g.routes.add(t.route);
    else byStop.set(t.stop, { tick: t, routes: new Set([t.route]) });
  }
  return {
    type: "FeatureCollection",
    features: [...byStop.values()].map(({ tick: t, routes }) => {
      const own = [...routes].filter((r) => !corridor.has(r));
      return {
        type: "Feature" as const,
        id: index.get(t.stop)!,
        properties: {
          route: t.route,
          routes: `,${[...routes].join(",")},`,
          n: routes.size,
          stop: t.stop,
          bearing: t.bearing,
          // Served only by routes drawn on their own: their colour.
          branded: own.length === routes.size,
          color: color.get(own[0] ?? t.route) ?? "#888",
        },
        geometry: { type: "Point" as const, coordinates: [t.lon, t.lat] },
      };
    }),
  };
}

function stopIndex(plan: ServicePlan): Map<string, number> {
  return new Map(plan.stops.map((s, i) => [s.id, i]));
}

/** Indices of the stops with a tick (their feature ids, when the plan has corridors). */
export function tickStops(plan: ServicePlan): number[] {
  const index = stopIndex(plan);
  return [...new Set(busStopTicks(plan).map((t) => index.get(t.stop)!))];
}

/**
 * A bar from the icon's centre to its top edge, as a signed distance field so MapLibre can colour it
 * per route (icon-color). Rotated by bearing, it juts from the route line toward the stop.
 */
function tickImage(): { width: number; height: number; data: Uint8Array } {
  const pad = 4;
  const barW = 6;
  const barH = 20;
  const width = barW + 2 * pad;
  const height = 2 * (barH + pad);
  const data = new Uint8Array(width * height * 4);
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Signed distance (px) to the bar [pad, pad+barW] × [cy-barH, cy], positive outside.
      const dx = Math.max(pad - (x + 0.5), x + 0.5 - (pad + barW));
      const dy = Math.max(cy - barH - (y + 0.5), y + 0.5 - cy);
      const d = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      // MapLibre's SDF edge is at 192/255; one step ≈ 1/8 px of buffer.
      data[i + 3] = Math.max(0, Math.min(255, Math.round(192 - d * 64)));
    }
  }
  return { width, height, data };
}

/** Bus exchanges away from stations (a station's bays are part of its marker). */
function exchangesGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: hubsOf(plan)
      .filter((h) => !h.station)
      .map((h) => ({
        type: "Feature" as const,
        properties: {
          id: h.id,
          name: h.name,
          // ",99,R4," as for bus stops (applyRouteFilter).
          routes: `,${h.routes.join(",")},`,
          n: h.routes.length,
        },
        geometry: { type: "Point" as const, coordinates: [h.lon, h.lat] },
      })),
  };
}

function stationsGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: plan.stations.map((s) => {
      const modes = new Set(
        s.routes.map((k) => plan.routes.find((r) => r.key === k)?.mode),
      );
      return {
        type: "Feature" as const,
        properties: {
          id: s.id,
          name: s.name,
          routes: s.routes.join(","),
          interchange: s.routes.length > 1,
          skytrain: modes.has("skytrain"),
        },
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      };
    }),
  };
}

/**
 * Add the plan's layers, or with them there already, update its stations and stops. `tiles` is the
 * plan's tiles' URL: other tiles (another feed version's) replace every layer. Returns whether the
 * lines' source was added (its tiles load from then on).
 */
export function addStaticLayers(
  map: MlMap,
  plan: ServicePlan,
  tiles: string,
  theme: Theme,
  hiddenRoutes: ReadonlySet<string>,
): boolean {
  const stations: GeoJSONSourceSpecification = {
    type: "geojson",
    data: stationsGeoJson(plan),
  };
  const shown = map.getStyle()?.sources[LINES_SOURCE];
  if (shown && "url" in shown && shown.url === tiles) {
    void (map.getSource(STATIONS_SOURCE) as GeoJSONSource).setData(
      stations.data as FeatureCollection,
    );
    void (map.getSource(EXCHANGES_SOURCE) as GeoJSONSource).setData(
      exchangesGeoJson(plan),
    );
    void (map.getSource(BUS_STOPS_SOURCE) as GeoJSONSource).setData(
      busStopsGeoJson(plan),
    );
    void (map.getSource(BUS_TICKS_SOURCE) as GeoJSONSource).setData(
      busTicksGeoJson(plan),
    );
    applyRouteFilter(map, hiddenRoutes);
    return false;
  }
  removeSources(map, STATIC_SOURCES);
  map.addSource(LINES_SOURCE, { type: "vector", url: tiles });
  map.addSource(STATIONS_SOURCE, stations);
  map.addSource(EXCHANGES_SOURCE, {
    type: "geojson",
    data: exchangesGeoJson(plan),
  });
  map.addSource(BUS_STOPS_SOURCE, {
    type: "geojson",
    data: busStopsGeoJson(plan),
  });
  map.addSource(BUS_TICKS_SOURCE, {
    type: "geojson",
    data: busTicksGeoJson(plan),
  });
  if (!map.hasImage(TICK_IMAGE))
    map.addImage(TICK_IMAGE, tickImage(), { sdf: true, pixelRatio: 2 });
  const dark = theme === "dark";
  const casing = dark ? "#111418" : "#ffffff";
  const text = dark ? "#e6e8eb" : "#1f2328";
  const halo = dark ? "#111418" : "#ffffff";
  const mutedText = dark ? "#c3c8ce" : "#3d434a";
  const tierColors = TIER_COLORS[dark ? "dark" : "light"];
  const noServiceColor = NO_SERVICE.color[dark ? "dark" : "light"];
  const brands = brandedRoutes(plan);
  /** The colour of the route with its own colour in feature state `brand`. */
  const brandColorOf = (color: (r: PlanRoute) => string) =>
    (brands.length ?
      [
        "match",
        BRAND,
        ...brands.flatMap((r, i) => [i, color(r)]),
        "rgba(0,0,0,0)",
      ]
    : "rgba(0,0,0,0)") as unknown as ExpressionSpecification;
  const brandColor = brandColorOf((r) => r.color);
  const fadedBrandColor = brandColorOf((r) => fadeColor(r.color, theme));
  const routeColor = focusColor(plan.routes, theme);
  /** Widths per tier at each zoom; with `only`, zero where it's false. */
  const tierWidth = (
    extra: number,
    tiers: number[],
    only?: ExpressionSpecification,
  ): ExpressionSpecification =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...TIER_WIDTHS.flatMap(([z, w]) => {
        const width = byTier(
          w.map((x, i) => (tiers.includes(i) ? x + extra : 0)),
          0,
        );
        return [z, only ? ["case", only, width, 0] : width];
      }),
    ] as ExpressionSpecification;

  // Bus corridors: one line per street, coloured and weighted by how often buses pass; the most
  // frequent tiers get a casing so they read over crossing streets. Zoomed out, divided roads are
  // one line (the overview corridors); closer in, each carriageway is its own.
  const source = LINES_SOURCE;
  const routes = {
    source,
    "source-layer": PLAN_TILE_LAYERS.routes,
  } as const;
  /** A corridor set's layers: the base ones now, the focused copies over SkyTrain (addFocusLayers). */
  const corridorSets = (
    [
      [
        "corridors-overview",
        PLAN_TILE_LAYERS.overviewCorridors,
        { maxzoom: CORRIDOR_DETAIL_ZOOM },
      ],
      [
        "corridors",
        PLAN_TILE_LAYERS.corridors,
        { minzoom: CORRIDOR_DETAIL_ZOOM },
      ],
    ] as const
  ).map(([prefix, sourceLayer, zooms]) => {
    const casingLayer = (
      id: string,
      width: ExpressionSpecification,
    ): LineLayerSpecification => ({
      id,
      type: "line",
      source,
      "source-layer": sourceLayer,
      minzoom: Math.max(12, "minzoom" in zooms ? zooms.minzoom : 0),
      ...("maxzoom" in zooms ? { maxzoom: zooms.maxzoom } : {}),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": casing,
        "line-width": width,
        "line-opacity": corridorCasingOpacity,
      },
    });
    const line: Omit<LineLayerSpecification, "id"> = {
      type: "line",
      source,
      "source-layer": sourceLayer,
      ...zooms,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": [
          "case",
          corridorDim,
          byTier(
            tierColors.map((c) => fadeColor(c, theme)),
            "rgba(0,0,0,0)",
          ),
          byTier(tierColors, "rgba(0,0,0,0)"),
        ],
        // …and at least as wide as Poor, so a Bad route stands out when its card is open.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          ...TIER_WIDTHS.flatMap(([z, w]) => [
            z,
            [
              "case",
              corridorFocused,
              byTier(
                w.map((x) => Math.max(x, w[2]!)),
                0,
              ),
              byTier(w, 0),
            ],
          ]),
        ] as ExpressionSpecification,
        // Full strength on the focused route's corridors, however infrequent.
        "line-opacity": ["case", corridorFocused, 1, byTier(TIER_OPACITY, 1)],
      },
    };
    // Routes with their own colour, over the corridors they run along: the busiest one running at
    // the time shown (feature state `brand`, an index into brandedRoutes), thicker and cased.
    const brandWidth = (
      extra: number,
      only?: ExpressionSpecification,
    ): ExpressionSpecification =>
      [
        "interpolate",
        ["linear"],
        ["zoom"],
        ...BRAND_WIDTHS.flatMap(([z, w]) => [
          z,
          [
            "case",
            ["all", brandShown, [">=", BRAND, 0], ...(only ? [only] : [])],
            w + extra,
            0,
          ],
        ]),
      ] as ExpressionSpecification;
    const brandLayer = (
      id: string,
      only?: ExpressionSpecification,
    ): LineLayerSpecification => ({
      id,
      type: "line",
      source,
      "source-layer": sourceLayer,
      ...zooms,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["case", corridorDim, fadedBrandColor, brandColor],
        "line-width": brandWidth(0, only),
      },
    });
    map.addLayer(casingLayer(`${prefix}-casing`, tierWidth(2, [0, 1])));
    // Corridors whose routes don't run in the window (feature state `idle`): dotted grey, beneath
    // the tiers, so a route the site mentions is never missing from the map.
    map.addLayer({
      id: `${prefix}-idle`,
      type: "line",
      source,
      "source-layer": sourceLayer,
      ...zooms,
      paint: {
        "line-color": [
          "case",
          corridorDim,
          fadeColor(noServiceColor, theme),
          noServiceColor,
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          ...TIER_WIDTHS.flatMap(([z, w]) => [
            z,
            ["case", corridorIdle, w[3]!, 0],
          ]),
        ] as ExpressionSpecification,
        // As thin as Bad and a little translucent, so it never outshines a route that runs.
        "line-opacity": 0.8,
        "line-dasharray": [2, 2],
      },
    });
    map.addLayer({ id: prefix, ...line });
    map.addLayer(casingLayer(`${prefix}-brand-casing`, brandWidth(2)));
    map.addLayer(brandLayer(`${prefix}-brand`));
    // The focused corridors again, on top of everything but stations, exchanges and labels
    // (packages/transit-map/README.md#route-focus): another route's corridor along the same street
    // (the other direction) can come later in the tile and cover them, SkyTrain's lines are drawn
    // over the corridors, and lines can't be ordered by feature state. The same type, source, zooms,
    // layout and (no) filter as the layers beneath, so MapLibre builds one set of buffers for both,
    // and no filter or layout reads the focus (a change to global state those read reloads the
    // source's tiles): elsewhere they're zero wide.
    return [
      casingLayer(
        `${prefix}-focus-casing`,
        tierWidth(2, [0, 1], corridorFocused),
      ),
      {
        id: `${prefix}-focus`,
        ...line,
        paint: {
          ...line.paint,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            ...TIER_WIDTHS.flatMap(([z, w]) => [
              z,
              [
                "case",
                corridorFocused,
                byTier(
                  w.map((x) => Math.max(x, w[2]!)),
                  0,
                ),
                0,
              ],
            ]),
          ] as ExpressionSpecification,
        },
      },
      casingLayer(
        `${prefix}-brand-focus-casing`,
        brandWidth(2, corridorFocused),
      ),
      brandLayer(`${prefix}-brand-focus`, corridorFocused),
    ] satisfies LineLayerSpecification[];
  });
  // Bus routes drawn on their own (99 B-Line, RapidBus; every route without corridors).
  map.addLayer({
    id: "routes-bus",
    type: "line",
    ...routes,
    filter: BUS_FREQUENT,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": routeColor,
      "line-opacity": drawsCorridors(plan) ? 1 : 0.55,
      "line-width":
        drawsCorridors(plan) ?
          [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1.5,
            13,
            3.2,
            15,
            4.5,
            17,
            6,
          ]
        : ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 4],
    },
  });
  map.addLayer({
    id: "routes-bus-limited",
    type: "line",
    ...routes,
    filter: BUS_LIMITED,
    layout: { "line-join": "round" },
    paint: {
      "line-color": routeColor,
      "line-opacity": 0.5,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 4],
      "line-dasharray": [1, 2],
    },
  });
  map.addLayer({
    id: "routes-shape-inactive",
    type: "line",
    ...routes,
    filter: SHAPE_INACTIVE,
    layout: { "line-join": "round" },
    paint: {
      "line-color": routeColor,
      "line-opacity": 0.6,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 3],
      "line-dasharray": [1, 2],
    },
  });
  map.addLayer({
    id: "routes-shape",
    type: "line",
    ...routes,
    filter: SHAPE_ACTIVE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": routeColor,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 13, 3, 16, 5],
    },
  });
  map.addLayer({
    id: "routes-skytrain-casing",
    type: "line",
    ...routes,
    filter: ["==", ["get", "kind"], "skytrain"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": casing,
      "line-opacity": casingOpacity(),
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        3.5,
        13,
        7,
        15,
        8,
        18,
        6,
      ],
    },
  });
  map.addLayer({
    id: "routes-skytrain",
    type: "line",
    ...routes,
    filter: ["==", ["get", "kind"], "skytrain"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": routeColor,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        2,
        13,
        4.5,
        15,
        5,
        18,
        3.5,
      ],
    },
  });
  // Express bus stops: a tick in the route colour toward the stop's side of the street (opposite
  // stops make a "+"), labelled only close in.
  const ticks: SymbolLayerSpecification = {
    id: "bus-stops",
    type: "symbol",
    source: BUS_TICKS_SOURCE,
    minzoom: 12,
    layout: {
      "icon-image": TICK_IMAGE,
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      // Bar ≈ line width thick, ≈ 2.5× line width long (the bus line is 2 px at z13, 4 px at z16).
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        12,
        0.45,
        14,
        0.8,
        16,
        1.2,
        18,
        1.5,
      ],
    },
    paint: {
      // With corridors: the colour of the route with its own colour stopping there where it's drawn
      // in it (only such routes serve the stop, not on a limited stretch), else the frequency tier.
      "icon-color": [
        "case",
        ["!", ["has", "branded"]],
        ["get", "color"],
        ["all", brandShown, [">=", BRAND, 0]],
        brandColor,
        byTier(tierColors, [
          "case",
          corridorIdle,
          noServiceColor,
          "rgba(0,0,0,0)",
        ]),
      ] as ExpressionSpecification,
      // The focused route's ticks are drawn by bus-stops-focus, over its corridors.
      "icon-opacity": [
        "case",
        ["all", focusSet, stopOnFocus],
        0,
        focusOpacity(0.9, stopOnFocus),
      ],
    },
  };
  map.addLayer(ticks);
  // SkyTrain's layers go here (tracks.ts → addTrackLayers: before FOCUS_LAYERS_START), then the
  // focused route over them, its stop ticks included.
  for (const layer of corridorSets.flat()) map.addLayer(layer);
  map.addLayer({
    ...ticks,
    id: "bus-stops-focus",
    paint: {
      ...ticks.paint,
      "icon-opacity": ["case", ["all", focusSet, stopOnFocus], 0.9, 0],
    },
  });
  // Bus exchanges: drawn like stations, in the stop labels' grey, once bus stops show.
  map.addLayer({
    id: "exchanges",
    type: "circle",
    source: EXCHANGES_SOURCE,
    minzoom: 11,
    paint: {
      "circle-color": casing,
      "circle-stroke-color": mutedText,
      "circle-stroke-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        11,
        1,
        14,
        2,
      ],
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        11,
        2.5,
        14,
        6,
        17,
        9,
      ],
    },
  });
  map.addLayer({
    id: "stations",
    type: "circle",
    source: STATIONS_SOURCE,
    paint: {
      "circle-color": casing,
      "circle-stroke-color": text,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 14, 2],
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        ["case", ["get", "interchange"], 3, 2],
        14,
        ["case", ["get", "interchange"], 7, 5],
        17,
        ["case", ["get", "interchange"], 10, 8],
      ],
    },
  });
  map.addLayer({
    id: "stations-label",
    type: "symbol",
    source: STATIONS_SOURCE,
    minzoom: 11,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Medium"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 13],
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-optional": true,
      "symbol-sort-key": ["case", ["get", "interchange"], 0, 1],
    },
    paint: {
      "text-color": text,
      "text-halo-color": halo,
      "text-halo-width": 1.5,
    },
  });
  map.addLayer(
    {
      id: VEHICLES_BEFORE_LAYER,
      type: "symbol",
      source: BUS_STOPS_SOURCE,
      minzoom: 14,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          10.5,
          16,
          12.5,
          18,
          14,
        ],
        "text-radial-offset": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          0.9,
          18,
          1.5,
        ],
        "text-anchor": ["get", "anchor"],
        "text-optional": true,
      },
      paint: {
        "text-color": mutedText,
        "text-halo-color": halo,
        "text-halo-width": 1.5,
        "text-opacity": focusOpacity(1, stopOnFocus),
      },
    },
    "stations-label",
  );
  // Beneath station labels, which win where they collide.
  map.addLayer(
    {
      id: "exchanges-label",
      type: "symbol",
      source: EXCHANGES_SOURCE,
      minzoom: 12,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 15, 12.5],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-color": mutedText,
        "text-halo-color": halo,
        "text-halo-width": 1.5,
      },
    },
    "stations-label",
  );
  applyRouteFilter(map, hiddenRoutes);
  return true;
}

/** The ferry berth pair in use on the day shown; the other pairs' routes are drawn dotted. */
export function setFerryPair(map: MlMap, pair: string | undefined): void {
  map.setGlobalStateProperty(FERRY_PAIR, pair ?? null);
}

/** Sources addStaticLayers adds. */
export const STATIC_SOURCES = [
  LINES_SOURCE,
  STATIONS_SOURCE,
  EXCHANGES_SOURCE,
  BUS_STOPS_SOURCE,
  BUS_TICKS_SOURCE,
];

/** Remove these sources and every layer drawing from them. */
export function removeSources(map: MlMap, sources: readonly string[]): void {
  for (const layer of map.getStyle()?.layers ?? [])
    if ("source" in layer && sources.includes(layer.source))
      map.removeLayer(layer.id);
  for (const s of sources) if (map.getSource(s)) map.removeSource(s);
}

export function applyRouteFilter(
  map: MlMap,
  hidden: ReadonlySet<string>,
): void {
  const visible: ExpressionSpecification = [
    "!",
    ["in", ["get", "route"], ["literal", [...hidden]]],
  ];
  for (const [id, base] of [
    ["routes-bus", BUS_FREQUENT],
    ["routes-bus-limited", BUS_LIMITED],
    ["routes-shape", SHAPE_ACTIVE],
    ["routes-shape-inactive", SHAPE_INACTIVE],
    ["routes-skytrain-casing", ["==", ["get", "kind"], "skytrain"]],
    ["routes-skytrain", ["==", ["get", "kind"], "skytrain"]],
  ] as [string, ExpressionSpecification][]) {
    if (map.getLayer(id)) map.setFilter(id, ["all", base, visible]);
  }
  // A bus stop or exchange shows while any of its routes is visible.
  const hiddenAtStop: ExpressionSpecification = [
    "+",
    0,
    0,
    ...[...hidden].map(
      (r) =>
        [
          "case",
          ["in", `,${r},`, ["get", "routes"]],
          1,
          0,
        ] as ExpressionSpecification,
    ),
  ];
  const stopVisible: ExpressionSpecification = [
    "<",
    hiddenAtStop,
    ["get", "n"],
  ];
  for (const id of [
    VEHICLES_BEFORE_LAYER,
    "exchanges",
    "exchanges-label",
    "bus-stops",
    "bus-stops-focus",
  ])
    if (map.getLayer(id)) map.setFilter(id, stopVisible);
}

/** Station, exchange and bus stop markers and their labels (the layers panel's "Stations & stops"). */
export function applyStopsVisibility(map: MlMap, shown: boolean): void {
  for (const id of [
    "stations",
    "stations-label",
    "exchanges",
    "exchanges-label",
    "bus-stops",
    "bus-stops-focus",
    VEHICLES_BEFORE_LAYER,
  ])
    if (map.getLayer(id))
      map.setLayoutProperty(id, "visibility", shown ? "visible" : "none");
}

/**
 * A ring around the selected station, exchange or stop (its card is open), or none. Re-call after a style
 * change: it adds its source and layer when they're missing.
 */
export function setSelectedPlace(
  map: MlMap,
  at: [number, number] | undefined,
): void {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features:
      at ?
        [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: at },
          },
        ]
      : [],
  };
  const source = map.getSource(SELECTED_PLACE_SOURCE) as
    GeoJSONSource | undefined;
  if (source) void source.setData(data);
  else map.addSource(SELECTED_PLACE_SOURCE, { type: "geojson", data });
  if (!map.getLayer(SELECTED_PLACE_LAYER))
    map.addLayer(
      {
        id: SELECTED_PLACE_LAYER,
        type: "circle",
        source: SELECTED_PLACE_SOURCE,
        paint: {
          "circle-radius": SELECTED_PLACE_RADIUS_PX,
          "circle-color": "#31cddc",
          "circle-opacity": 0.28,
          "circle-stroke-color": "#0d98a6",
          "circle-stroke-width": 2,
        },
      },
      map.getLayer("stations") ? "stations" : undefined,
    );
}
