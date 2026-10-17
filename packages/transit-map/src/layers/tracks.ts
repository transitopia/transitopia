// SkyTrain track layers from the infrastructure model (packages/transit-map/README.md#rendering). Below
// RIBBON_ZOOM each line is a stroke along its centreline (both tracks of a pair as one line, split
// lengthwise in both lines' colours where they share track); from it, a ribbon the guideway's true
// width, one polygon per line, with the tracks as white hairlines inside, fading to half opacity close
// in so bus stops and streets under or over the guideway show. Both come from lines.geojson
// (packages/transit-core/src/infra/line-geometry.ts). Yard tracks are grey; track OSM marks as under
// works is dashed. With ?debug=1: segment ids, node kinds and mapped GTFS platforms.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type { LineGeometry } from "@transitopia/transit-core/infra/line-geometry.ts";
import {
  feedDataPath,
  type PlanRoute,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { VEHICLES_BEFORE_LAYER } from "./static.ts";

export const TRACKS_SOURCE = "tracks";
export const LINES_SOURCE = "rail-lines";
const TRACK_LAYERS = [
  "tracks-yard",
  "rail-casing",
  "tracks-minor",
  "rail-centre",
  "rail-shared-a",
  "rail-shared-b",
  "rail-ribbon",
  "tracks-works",
  "tracks-hairline",
];
/** SkyTrain layers a tap on the map can pick a line from. */
export const PICKABLE_TRACK_LAYERS = [
  "rail-centre",
  "rail-shared-a",
  "rail-shared-b",
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

export async function loadTracks(
  base: string,
  path: string,
): Promise<InfraCollection | undefined> {
  try {
    const res = await fetch(`${base}${path}`);
    return res.ok ? ((await res.json()) as InfraCollection) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line geometry published next to the tracks (lines.geojson, by build-infra and scenarios), or
 * undefined without it: SkyTrain then falls back to the GTFS shapes, as without tracks.
 */
export async function loadLines(
  base: string,
  tracksPath: string,
): Promise<LineGeometry | undefined> {
  try {
    const res = await fetch(
      `${base}${tracksPath.replace(/tracks\.geojson$/, "lines.geojson")}`,
    );
    return res.ok ? ((await res.json()) as LineGeometry) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPlatforms(
  base: string,
  feed: string,
  feedVersion: string,
): Promise<PlatformsFile | undefined> {
  try {
    const res = await fetch(
      `${base}${feedDataPath(feed, feedVersion, "platforms.json")}`,
    );
    return res.ok ? ((await res.json()) as PlatformsFile) : undefined;
  } catch {
    return undefined;
  }
}

function colored(
  tracks: InfraCollection,
  routes: PlanRoute[],
  yardColor: string,
): FeatureCollection {
  const color = new Map(routes.map((r) => [r.key, r.color]));
  return {
    type: "FeatureCollection",
    features: tracks.features.map((f) => {
      if (f.properties.type !== "segment") return f as GeoJSON.Feature;
      const p = f.properties;
      const line = p.lines[0];
      return {
        ...f,
        properties: {
          ...p,
          line: line ?? "",
          color:
            p.kind === "yard" || !line ?
              yardColor
            : (color.get(line) ?? yardColor),
        },
      } as GeoJSON.Feature;
    }),
  };
}

function coloredLines(
  lines: LineGeometry,
  routes: PlanRoute[],
): FeatureCollection {
  const color = new Map(routes.map((r) => [r.key, r.color]));
  return {
    type: "FeatureCollection",
    features: lines.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        color: color.get(f.properties.line) ?? "#888",
        color2:
          f.properties.type === "centre" && f.properties.shared ?
            (color.get(f.properties.lines[1]!) ?? "#888")
          : "",
      },
    })) as GeoJSON.Feature[],
  };
}

export function addTrackLayers(
  map: MlMap,
  tracks: InfraCollection,
  lines: LineGeometry,
  plan: ServicePlan,
  theme: Theme,
  debug: boolean,
): void {
  const dark = theme === "dark";
  const yard = dark ? "#5b636d" : "#a9b0b8";
  const casing = dark ? "#15181c" : "#ffffff";
  const data = colored(tracks, plan.routes, yard);
  const lineData = coloredLines(lines, plan.routes);
  // Above bus stop ticks, so zoomed out the line hides stops under or over the guideway; they show
  // through once it fades close in. Below exchanges, stations and labels.
  const before =
    map.getLayer(VEHICLES_BEFORE_LAYER) && map.getLayer("exchanges") ?
      "exchanges"
    : undefined;
  if (map.getSource(TRACKS_SOURCE)) {
    void (map.getSource(TRACKS_SOURCE) as GeoJSONSource).setData(data);
    void (map.getSource(LINES_SOURCE) as GeoJSONSource).setData(lineData);
    return;
  }
  map.addSource(TRACKS_SOURCE, { type: "geojson", data });
  map.addSource(LINES_SOURCE, { type: "geojson", data: lineData });
  baseFilters.clear();
  const seg = ["==", ["get", "type"], "segment"] as ExpressionSpecification;
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

  map.addLayer(
    {
      id: "tracks-yard",
      type: "line",
      source: TRACKS_SOURCE,
      minzoom: 12,
      filter: ["all", seg, kind("yard")],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": width(0.5, 1, 3) },
    },
    before,
  );
  map.addLayer(
    {
      id: "rail-casing",
      type: "line",
      source: LINES_SOURCE,
      ...low,
      filter: centre,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": casing, "line-width": stroke(1, 3) },
    },
    before,
  );
  map.addLayer(
    {
      id: "tracks-minor",
      type: "line",
      source: TRACKS_SOURCE,
      minzoom: 12.5,
      ...low,
      filter: [
        "all",
        seg,
        kind("crossover", "pocket", "tail", "siding", "spur"),
        ["!", ["has", "works"]],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": width(0.8, 1.5, 3.5),
        "line-opacity": 0.9,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "rail-centre",
      type: "line",
      source: LINES_SOURCE,
      ...low,
      filter: ["all", centre, ["!", shared]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": stroke(1) },
    },
    before,
  );
  // Shared track: the first line on the left half of its west-to-east centreline, the second on the right.
  for (const [id, color, sign] of [
    ["rail-shared-b", "color2", 1],
    ["rail-shared-a", "color", -1],
  ] as const)
    map.addLayer(
      {
        id,
        type: "line",
        source: LINES_SOURCE,
        ...low,
        filter: ["all", centre, shared],
        layout: { "line-join": "round" },
        paint: {
          "line-color": ["get", color],
          "line-width": stroke(0.5),
          "line-offset": stroke(sign * 0.25),
        },
      },
      before,
    );
  // Close in: the ribbon, one polygon per line, so it fades evenly.
  map.addLayer(
    {
      id: "rail-ribbon",
      type: "fill",
      source: LINES_SOURCE,
      minzoom: RIBBON_ZOOM,
      filter: ["==", ["get", "type"], "ribbon"],
      paint: {
        "fill-color": ["get", "color"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 16, 1, 17, 0.5],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "tracks-works",
      type: "line",
      source: TRACKS_SOURCE,
      filter: ["all", seg, ["has", "works"]],
      paint: {
        "line-color": ["get", "color"],
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
      source: TRACKS_SOURCE,
      minzoom: RIBBON_ZOOM,
      filter: [
        "all",
        seg,
        kind("main", "crossover", "pocket", "tail", "siding", "spur"),
        ["!", ["has", "works"]],
      ],
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
          1,
          17,
          0.6,
        ],
      },
    },
    before,
  );
  if (debug)
    map.addLayer(
      {
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
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            15,
            1.5,
            18,
            4,
          ],
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
      },
      before,
    );

  for (const id of TRACK_LAYERS) {
    const f = map.getFilter(id);
    if (f) baseFilters.set(id, f as ExpressionSpecification);
  }

  if (!debug) return;
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
export function applyTrackFilter(map: MlMap, hidden: Set<string>): void {
  const lineVisible: ExpressionSpecification = [
    "!",
    ["in", ["get", "line"], ["literal", [...hidden]]],
  ];
  for (const id of TRACK_LAYERS) {
    const base = baseFilters.get(id);
    if (map.getLayer(id) && base) map.setFilter(id, ["all", base, lineVisible]);
  }
}
