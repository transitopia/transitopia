// SkyTrain track layers from the infrastructure model (packages/transit-map/README.md#rendering): every track, switch
// and pocket at true geometry. At city zoom parallel tracks (≈4 m apart) merge into one line, split
// lengthwise in both lines' colours where lines share track. From station zoom the line widens into a
// ribbon the width of the guideway with the tracks as white hairlines inside, fading to half opacity
// close in so bus stops and streets under or over the guideway show. Yard tracks are grey; track OSM
// marks as under works is dashed.
// With ?debug=1: segment ids, node kinds and mapped GTFS platforms.

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { InfraCollection } from "@transitopia/transit-core/infra/types.ts";
import { TrackGraph } from "@transitopia/transit-core/infra/graph.ts";
import { localProjector, type LonLat } from "@transitopia/transit-core/geo.ts";
import {
  feedDataPath,
  type PlanRoute,
  type ServicePlan,
} from "@transitopia/transit-core/plan/types.ts";
import type { Theme } from "@transitopia/map-style/basemap.ts";
import { VEHICLES_BEFORE_LAYER } from "./static.ts";

export const TRACKS_SOURCE = "tracks";
const TRACK_LAYERS = [
  "tracks-yard",
  "tracks-casing",
  "tracks-minor",
  "tracks-main",
  "tracks-pair",
  "tracks-shared-a",
  "tracks-shared-b",
  "tracks-works",
  "tracks-hairline",
];
/** The guideway ribbon at station zoom is this wide (m): two tracks ≈4 m apart, with a margin. */
const RIBBON_M = 9;
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

/**
 * A main track's parallel partner is within this distance (m): wide enough for twin bored tunnels
 * and island platforms, whose tracks then draw a half-width band each rather than overlapping.
 */
const PARTNER_M = 25;

/**
 * For each main track, which side of its parallel partner it's on (-1: left of its west-to-east
 * direction, 1: right, 0: no partner) and half the distance between them (m). Each of a pair draws
 * its half of the line (on shared track, one line's half), meeting at the pair's centreline, so
 * nothing overlaps and the ribbon fades evenly.
 */
function pairSides(
  segs: { id: string; coords: LonLat[] }[],
): Map<string, { side: -1 | 0 | 1; halfSep: number }> {
  const out = new Map<string, { side: -1 | 0 | 1; halfSep: number }>();
  if (!segs.length) return out;
  const proj = localProjector(segs[0]!.coords[0]![1]);
  const xy = segs.map((s) => s.coords.map((c) => proj.toXY(c)));
  segs.forEach((s, i) => {
    const pts = xy[i]!;
    const m = Math.floor((pts.length - 1) / 2);
    const a = pts[m]!;
    const b = pts[Math.min(pts.length - 1, m + 1)]!;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best = { d: Infinity, cross: 0 };
    xy.forEach((other, j) => {
      if (j === i) return;
      for (let k = 0; k + 1 < other.length; k++) {
        const [px, py] = other[k]!;
        const [qx, qy] = other[k + 1]!;
        const dx = qx - px;
        const dy = qy - py;
        const l2 = dx * dx + dy * dy;
        const f =
          l2 > 0 ?
            Math.max(
              0,
              Math.min(1, ((mid[0] - px) * dx + (mid[1] - py) * dy) / l2),
            )
          : 0;
        const cx = px + dx * f - mid[0];
        const cy = py + dy * f - mid[1];
        const d = Math.hypot(cx, cy);
        // Ignore tracks it joins end to end (distance ~0 at a shared node).
        if (d > 0.5 && d < best.d)
          best = { d, cross: (b[0] - a[0]) * cy - (b[1] - a[1]) * cx };
      }
    });
    out.set(
      s.id,
      best.d <= PARTNER_M ?
        // Partner to the left (cross > 0 in x-east, y-north): this is the right-hand track.
        { side: best.cross > 0 ? 1 : -1, halfSep: best.d / 2 }
      : { side: 0, halfSep: 0 },
    );
  });
  return out;
}

function colored(
  tracks: InfraCollection,
  routes: PlanRoute[],
  yardColor: string,
): FeatureCollection {
  const color = new Map(routes.map((r) => [r.key, r.color]));
  // Main track is drawn by line-offset, which is relative to the direction of drawing: draw it
  // west to east, so each half keeps its side.
  const eastward = (c: LonLat[]) =>
    c[c.length - 1]![0] < c[0]![0] ? [...c].reverse() : c;
  const sides = pairSides(
    tracks.features.flatMap((f) =>
      (
        f.properties.type === "segment"
        && f.properties.kind === "main"
        && f.geometry.type === "LineString"
      ) ?
        [
          {
            id: f.properties.id,
            coords: eastward(f.geometry.coordinates as LonLat[]),
          },
        ]
      : [],
    ),
  );
  return {
    type: "FeatureCollection",
    features: tracks.features.map((f) => {
      if (f.properties.type !== "segment") return f as GeoJSON.Feature;
      const p = f.properties;
      const line = p.lines[0];
      const shared = p.lines.length > 1 && p.kind !== "yard";
      let geometry = f.geometry;
      if (p.kind === "main" && geometry.type === "LineString")
        geometry = {
          ...geometry,
          coordinates: eastward(geometry.coordinates as LonLat[]),
        };
      const pair = sides.get(p.id) ?? { side: 0, halfSep: 0 };
      return {
        ...f,
        geometry,
        properties: {
          ...p,
          line: line ?? "",
          shared,
          color:
            p.kind === "yard" || !line ?
              yardColor
            : (color.get(line) ?? yardColor),
          color2: shared ? (color.get(p.lines[1]!) ?? yardColor) : "",
          side: pair.side,
          halfSep: pair.halfSep,
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
  // Above bus stop ticks, so zoomed out the line hides stops under or over the guideway; they show
  // through once it fades close in. Below exchanges, stations and labels.
  const before =
    map.getLayer(VEHICLES_BEFORE_LAYER) && map.getLayer("exchanges") ?
      "exchanges"
    : undefined;
  if (map.getSource(TRACKS_SOURCE)) {
    void (map.getSource(TRACKS_SOURCE) as GeoJSONSource).setData(data);
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

  const shared = ["get", "shared"] as ExpressionSpecification;
  const paired = ["!=", ["get", "side"], 0] as ExpressionSpecification;
  // The line's width: a line at city zoom, the guideway's true width from station zoom (metres at
  // this latitude, doubling per zoom level).
  const mpp15 =
    (40_075_016.686 * Math.cos((49.25 * Math.PI) / 180)) / (512 * 2 ** 15);
  const ZOOMS = [10, 12, 14, 15, 16, 17, 18, 19, 20];
  /** The line's width at a zoom (px): thicker than any bus corridor, then the ribbon. */
  const lineAt = (z: number) =>
    z <= 10 ? 3
    : z <= 12 ? 4.5
    : z <= 14 ? 6.5
    : Math.max(7, (RIBBON_M / mpp15) * 2 ** (z - 15));
  const pxPerM = (z: number) => 2 ** (z - 15) / mpp15;
  const lineStops = (scale: number, extra = 0): number[] =>
    ZOOMS.flatMap((z) => [z, lineAt(z) * scale + extra]);
  const lineWidth = (scale: number, extra = 0) =>
    [
      "interpolate",
      ["exponential", 2],
      ["zoom"],
      ...lineStops(scale, extra),
    ] as ExpressionSpecification;
  // Close in, the whole line fades to half opacity, so bus stops and streets under or over the
  // guideway show; zoomed out it's drawn solid everywhere.
  const fade = (to = 0.5) =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      16,
      1,
      17,
      to,
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
  // The casing goes as the line fades, so what's beneath shows through.
  map.addLayer(
    {
      id: "tracks-casing",
      type: "line",
      source: TRACKS_SOURCE,
      filter: ["all", seg, kind("main")],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": casing,
        "line-width": lineWidth(1, 3),
        "line-opacity": fade(0),
      },
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
        // A thin line at city zoom, wide enough close in to carry its hairline.
        "line-width": [
          "interpolate",
          ["exponential", 2],
          ["zoom"],
          10,
          0.8,
          14,
          1.5,
          16,
          4,
          20,
          40,
        ],
        "line-opacity": fade(0.45),
      },
    },
    before,
  );
  // Main track without a parallel partner (single track): the whole line on it.
  map.addLayer(
    {
      id: "tracks-main",
      type: "line",
      source: TRACKS_SOURCE,
      filter: [
        "all",
        seg,
        kind("main"),
        ["!", paired],
        ["!", shared],
        ["!", ["has", "works"]],
      ],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": lineWidth(1),
        "line-opacity": fade(),
      },
    },
    before,
  );
  // A pair of parallel tracks: each draws its own half of the line, offset so the halves meet at
  // the pair's centreline. On shared track the left one draws the first line's colour and the right
  // one the second's (packages/transit-map/README.md#rendering).
  map.addLayer(
    {
      id: "tracks-pair",
      type: "line",
      source: TRACKS_SOURCE,
      filter: ["all", seg, kind("main"), paired, ["!", ["has", "works"]]],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": [
          "case",
          ["all", shared, [">", ["get", "side"], 0]],
          ["get", "color2"],
          ["get", "color"],
        ],
        "line-width": lineWidth(0.5),
        "line-offset": [
          "interpolate",
          ["exponential", 2],
          ["zoom"],
          ...ZOOMS.flatMap((z) => [
            z,
            [
              "*",
              ["get", "side"],
              [
                "max",
                0,
                ["-", lineAt(z) / 4, ["*", ["get", "halfSep"], pxPerM(z)]],
              ],
            ],
          ]),
        ] as unknown as ExpressionSpecification,
        "line-opacity": fade(),
      },
    },
    before,
  );
  // Single shared track: both halves on it.
  for (const [id, color, sign] of [
    ["tracks-shared-b", "color2", 1],
    ["tracks-shared-a", "color", -1],
  ] as const)
    map.addLayer(
      {
        id,
        type: "line",
        source: TRACKS_SOURCE,
        filter: [
          "all",
          seg,
          kind("main"),
          shared,
          ["!", paired],
          ["!", ["has", "works"]],
        ],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": ["get", color],
          "line-width": lineWidth(0.5),
          "line-offset": [
            "interpolate",
            ["exponential", 2],
            ["zoom"],
            ...lineStops(sign * 0.25),
          ],
          "line-opacity": fade(),
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
        "line-opacity": fade(),
      },
    },
    before,
  );
  // The tracks themselves inside the ribbon, from station zoom.
  map.addLayer(
    {
      id: "tracks-hairline",
      type: "line",
      source: TRACKS_SOURCE,
      minzoom: 15,
      filter: [
        "all",
        seg,
        kind("main", "crossover", "pocket", "tail", "siding", "spur"),
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
          15.3,
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
