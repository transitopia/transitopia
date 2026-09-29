// SkyTrain track layers from the infrastructure model (docs/skytrain-viz-PLAN.md §4.1, §4.9): every track, switch
// and pocket at true geometry. At city zoom parallel tracks (≈4 m apart) merge into one line; at
// station zoom they separate. Yard tracks are grey; track OSM marks as under works is dashed.
// With ?debug=1: segment ids, node kinds and mapped GTFS platforms.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import type {
  PlanRoute,
  ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type { Theme } from "../basemap.ts";
import { VEHICLES_BEFORE_LAYER } from "./static.ts";

export const TRACKS_SOURCE = "tracks";
const TRACK_LAYERS = [
  "tracks-yard",
  "tracks-casing",
  "tracks-minor",
  "tracks-main",
  "tracks-works",
];
/** Each track layer's own filter, so line visibility can be combined with it. */
const baseFilters = new Map<string, ExpressionSpecification>();
const DEBUG_SOURCE = "tracks-debug";
const BASE = import.meta.env.BASE_URL;

export interface PlatformsFile {
  feedVersion: string;
  platforms: Record<
    string,
    { seg: string; offset: number; dist: number; method: string }
  >;
}

export async function loadTracks(
  path = "data/infra/tracks.geojson",
): Promise<InfraCollection | undefined> {
  try {
    const res = await fetch(`${BASE}${path}`);
    return res.ok ? ((await res.json()) as InfraCollection) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadPlatforms(
  feedVersion: string,
): Promise<PlatformsFile | undefined> {
  try {
    const res = await fetch(`${BASE}data/feeds/${feedVersion}/platforms.json`);
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
      // Shared Expo/Millennium track takes the Expo colour.
      const line = p.lines.includes("expo") ? "expo" : p.lines[0];
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

export function addTrackLayers(
  map: MlMap,
  tracks: InfraCollection,
  plan: ServicePlan,
  theme: Theme,
  debug: boolean,
): void {
  const dark = theme === "dark";
  const yard = dark ? "#5b636d" : "#a9b0b8";
  const casing = dark ? "#15181c" : "#ffffff";
  const data = colored(tracks, plan.routes, yard);
  const before = map.getLayer(VEHICLES_BEFORE_LAYER) ? "bus-stops" : undefined;
  if (map.getSource(TRACKS_SOURCE)) {
    (map.getSource(TRACKS_SOURCE) as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(TRACKS_SOURCE, { type: "geojson", data });
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
      id: "tracks-casing",
      type: "line",
      source: TRACKS_SOURCE,
      filter: ["all", seg, kind("main")],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": casing, "line-width": width(4, 6, 7) },
    },
    before,
  );
  map.addLayer(
    {
      id: "tracks-minor",
      type: "line",
      source: TRACKS_SOURCE,
      minzoom: 12.5,
      filter: [
        "all",
        seg,
        kind("crossover", "pocket", "tail", "siding", "spur"),
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
      id: "tracks-main",
      type: "line",
      source: TRACKS_SOURCE,
      filter: ["all", seg, kind("main"), ["!", ["has", "works"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": width(2, 3, 4) },
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
  src.setData({ type: "FeatureCollection", features });
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
