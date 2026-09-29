// Static transit layers drawn by MapLibre: route lines from GTFS shapes, and stations.
// Track-level SkyTrain geometry (docs/skytrain-viz-PLAN.md §4.1) will replace the SkyTrain shapes in M3.

import type { FeatureCollection, Feature } from "geojson";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type {
  ExpressionSpecification,
  GeoJSONSourceSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import type { ServicePlan } from "@transitopia/transit-core/plan/types.ts";
import { routeSections } from "@transitopia/transit-core/plan/coverage.ts";
import {
  busStopMarkers,
  busStopTicks,
} from "@transitopia/transit-core/plan/bus-stops.ts";
import type { Theme } from "@transitopia/map-style/basemap.ts";

export const ROUTES_SOURCE = "transit-routes";
export const STATIONS_SOURCE = "transit-stations";
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

const KIND_ORDER: Record<string, number> = { bus: 0, shape: 1, skytrain: 2 };
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

function routesGeoJson(plan: ServicePlan): FeatureCollection {
  const features: Feature[] = [];
  const seen = new Set<string>();
  // Buses: split into frequent sections, and limited-service or no-passenger ones (drawn dotted).
  const busRoutes = new Set(
    plan.routes.filter((r) => r.kind === "bus").map((r) => r.key),
  );
  for (const sec of routeSections(plan, busRoutes)) {
    const route = plan.routes.find((r) => r.key === sec.route)!;
    features.push({
      type: "Feature",
      properties: {
        route: route.key,
        kind: route.kind,
        mode: route.mode,
        color: route.color,
        order: 0,
        limited: sec.limited,
        empty: sec.empty,
      },
      geometry: { type: "LineString", coordinates: sec.coords },
    });
  }
  const used = new Set(plan.trips.map((t) => t.pattern));
  for (const p of plan.patterns) {
    if (busRoutes.has(p.route) || !used.has(p.id)) continue;
    const route = plan.routes.find((r) => r.key === p.route)!;
    // A ferry may use any of its berth pairs on a given day (AIS decides): draw them all, tagged
    // with their pair, so the ones not in use can be drawn dotted.
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
        properties: {
          route: route.key,
          kind: route.kind,
          mode: route.mode,
          color: route.color,
          order: KIND_ORDER[route.kind] ?? 0,
          ...(pair ? { berthPair: pair } : {}),
        },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function busStopsGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: busStopMarkers(plan).map((s) => ({
      type: "Feature" as const,
      properties: {
        name: s.name,
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

function busTicksGeoJson(plan: ServicePlan): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: busStopTicks(plan).map((t) => ({
      type: "Feature" as const,
      properties: {
        route: t.route,
        bearing: t.bearing,
        color: plan.routes.find((r) => r.key === t.route)?.color ?? "#888",
      },
      geometry: { type: "Point" as const, coordinates: [t.lon, t.lat] },
    })),
  };
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

export function addStaticLayers(
  map: MlMap,
  plan: ServicePlan,
  theme: Theme,
  hiddenRoutes: Set<string>,
): void {
  const routes: GeoJSONSourceSpecification = {
    type: "geojson",
    data: routesGeoJson(plan),
  };
  const stations: GeoJSONSourceSpecification = {
    type: "geojson",
    data: stationsGeoJson(plan),
  };
  if (map.getSource(ROUTES_SOURCE)) {
    (map.getSource(ROUTES_SOURCE) as GeoJSONSource).setData(
      routes.data as FeatureCollection,
    );
    (map.getSource(STATIONS_SOURCE) as GeoJSONSource).setData(
      stations.data as FeatureCollection,
    );
    (map.getSource(BUS_STOPS_SOURCE) as GeoJSONSource).setData(
      busStopsGeoJson(plan),
    );
    (map.getSource(BUS_TICKS_SOURCE) as GeoJSONSource).setData(
      busTicksGeoJson(plan),
    );
    applyRouteFilter(map, hiddenRoutes);
    return;
  }
  map.addSource(ROUTES_SOURCE, routes);
  map.addSource(STATIONS_SOURCE, stations);
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

  map.addLayer({
    id: "routes-bus",
    type: "line",
    source: ROUTES_SOURCE,
    filter: BUS_FREQUENT,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 0.55,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 4],
    },
  });
  map.addLayer({
    id: "routes-bus-limited",
    type: "line",
    source: ROUTES_SOURCE,
    filter: BUS_LIMITED,
    layout: { "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 0.5,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 4],
      "line-dasharray": [1, 2],
    },
  });
  map.addLayer({
    id: "routes-shape-inactive",
    type: "line",
    source: ROUTES_SOURCE,
    filter: SHAPE_INACTIVE,
    layout: { "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 0.6,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 3],
      "line-dasharray": [1, 2],
    },
  });
  map.addLayer({
    id: "routes-shape",
    type: "line",
    source: ROUTES_SOURCE,
    filter: SHAPE_ACTIVE,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 13, 3, 16, 5],
    },
  });
  map.addLayer({
    id: "routes-skytrain-casing",
    type: "line",
    source: ROUTES_SOURCE,
    filter: ["==", ["get", "kind"], "skytrain"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": casing,
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
    source: ROUTES_SOURCE,
    filter: ["==", ["get", "kind"], "skytrain"],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
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
  map.addLayer({
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
    paint: { "icon-color": ["get", "color"], "icon-opacity": 0.85 },
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
      },
    },
    "stations-label",
  );
  applyRouteFilter(map, hiddenRoutes);
}

/** The ferry berth pair in use on the day shown; the other pairs' routes are drawn dotted. */
export function setFerryPair(map: MlMap, pair: string | undefined): void {
  map.setGlobalStateProperty(FERRY_PAIR, pair ?? null);
}

export function applyRouteFilter(map: MlMap, hidden: Set<string>): void {
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
  // A bus stop shows while any of its routes is visible.
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
  if (map.getLayer(VEHICLES_BEFORE_LAYER))
    map.setFilter(VEHICLES_BEFORE_LAYER, stopVisible);
  if (map.getLayer("bus-stops")) map.setFilter("bus-stops", visible);
}
