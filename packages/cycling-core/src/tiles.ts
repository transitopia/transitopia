// The cycling tiles (packages/cycling-core/README.md#tiles): what the pipeline writes and the site reads.

import type { TileFeature } from "@transitopia/transit-core/plan/tiles.ts";
import {
  joinChains,
  type Chain,
  type ClassifiedWay,
  type LonLat,
} from "./chains.ts";
import type { WayClass } from "./classify.ts";

/** The tiles' one layer: paths, lanes and bike parking. */
export const CYCLING_LAYER = "transitopia_cycling";
export const CYCLING_MIN_ZOOM = 6;
export const CYCLING_MAX_ZOOM = 14;
/**
 * From this zoom paths carry their name, surface and routes, and have ids (their chain's): the map
 * highlights and selects them only from here. Below it, paths are joined by what's drawn only.
 */
export const CYCLING_DETAIL_ZOOM = 13;
/** Bike parking appears from this zoom. */
export const PARKING_MIN_ZOOM = 12;
/** Pixels of each neighbouring tile kept in a tile (of 256), so lines join cleanly at tile edges. */
export const CYCLING_TILE_BUFFER = 4;
/**
 * Below CYCLING_DETAIL_ZOOM a chain shows from the zoom at which its group is at least this long
 * (pixels of a 256-pixel tile), so the widest views aren't crumbs.
 */
const MIN_PX = 1;

/** A path's or lane's attributes in the tiles. */
export type CyclingWayProperties = WayClass & {
  /** From CYCLING_DETAIL_ZOOM. */
  name?: string;
  /** OSM's surface value, from CYCLING_DETAIL_ZOOM. */
  surface?: string;
  /** The OSM bike route relations it's part of, ids in ascending order, comma-separated; from CYCLING_DETAIL_ZOOM. */
  routes?: string;
};

/** Bike parking in the tiles: an OSM node, or the centre of an OSM way around an area, with its details. */
export type BikeParkingProperties = {
  amenity: "bicycle_parking";
  name?: string;
  /** OSM's `bicycle_parking`: the kind of parking (stands, wall_loops, lockers, …). */
  bicycle_parking?: string;
  /** Bikes it holds (only where OSM's `capacity` is a plain number). */
  capacity?: number;
  /** OSM's `covered`: anything but "no" (partial, …) is true. */
  covered?: boolean;
  /** OSM's `indoor`: anything but "no" (room, area, …) is true. */
  indoor?: boolean;
  operator?: string;
  osmNodeId?: number;
  osmWayId?: number;
};

/** A bike parking point before tiling. */
export interface BikeParking {
  lonLat: [number, number];
  properties: BikeParkingProperties;
}

/** Only on paths from CYCLING_DETAIL_ZOOM. */
const DETAIL_KEYS = [
  "name",
  "surface",
  "routes",
] as const satisfies (keyof CyclingWayProperties)[];

/**
 * A tile feature id for an OSM element, unique across element types (node 1, way 2, relation 3 in
 * the last digit). A path's is its chain's first way by id.
 */
export function osmFeatureId(
  type: "node" | "way" | "relation",
  id: number,
): number {
  return (
    id * 10
    + (type === "node" ? 1
    : type === "way" ? 2
    : 3)
  );
}

/** Attributes as a key for joining: the same attributes give the same key. */
const keyOf = (attrs: object) =>
  JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1)));

const isDirected = (a: WayClass) => a.oneway !== 0;

/** A line's length in pixels at zoom 0 (Web Mercator, 256-pixel tiles). */
function pixelLength(coords: readonly LonLat[]): number {
  const project = ([lon, lat]: LonLat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return [
      ((lon + 180) / 360) * 256,
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256,
    ] as const;
  };
  let px = 0;
  let [x0, y0] = project(coords[0]!);
  for (const c of coords.slice(1)) {
    const [x, y] = project(c);
    px += Math.hypot(x - x0, y - y0);
    [x0, y0] = [x, y];
  }
  return px;
}

/**
 * For each chain, the length (pixels at zoom 0) of the group it's in: the chains with the same
 * properties connected to it end to end or at junctions.
 */
function groupLengths(
  chains: readonly Chain<WayClass>[],
  px: readonly number[],
): number[] {
  const parent = chains.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  // Chains meet at their ends (each chain ends where it meets another).
  const at = new Map<string, number>();
  chains.forEach((c, i) => {
    const key = keyOf(c.attrs);
    for (const [lon, lat] of [c.coords[0]!, c.coords.at(-1)!]) {
      const k = `${key}@${lon},${lat}`;
      const j = at.get(k);
      if (j === undefined) at.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const total = new Map<number, number>();
  px.forEach((p, i) => total.set(find(i), (total.get(find(i)) ?? 0) + p));
  return chains.map((_, i) => total.get(find(i))!);
}

/** Every feature of the cycling tiles, for tippecanoe. */
export function* cyclingTileFeatures(
  ways: readonly ClassifiedWay<CyclingWayProperties>[],
  parking: readonly BikeParking[],
): Generator<TileFeature> {
  // Detail: whole chains with every attribute, and an id.
  for (const c of joinChains(ways, keyOf, isDirected))
    yield {
      type: "Feature",
      id: osmFeatureId("way", Math.min(...c.wayIds)),
      properties: c.attrs,
      geometry: { type: "LineString", coordinates: c.coords },
      tippecanoe: { layer: CYCLING_LAYER, minzoom: CYCLING_DETAIL_ZOOM },
    };
  // Overview: chains joined by what's drawn, without ids, from the zoom at which they show.
  const drawn = ways.map((w) => {
    const attrs: Partial<CyclingWayProperties> = { ...w.attrs };
    for (const k of DETAIL_KEYS) delete attrs[k];
    return { ...w, attrs: attrs as WayClass };
  });
  const chains = joinChains(drawn, keyOf, isDirected);
  const px = chains.map((c) => pixelLength(c.coords));
  const groupPx = groupLengths(chains, px);
  for (const [i, c] of chains.entries()) {
    const z = Math.max(
      CYCLING_MIN_ZOOM,
      Math.ceil(Math.log2(MIN_PX / groupPx[i]!)),
    );
    if (z < CYCLING_DETAIL_ZOOM)
      yield {
        type: "Feature",
        properties: c.attrs,
        geometry: { type: "LineString", coordinates: c.coords },
        tippecanoe: {
          layer: CYCLING_LAYER,
          minzoom: z,
          maxzoom: CYCLING_DETAIL_ZOOM - 1,
        },
      };
  }
  for (const p of parking)
    yield {
      type: "Feature",
      id:
        p.properties.osmNodeId === undefined ?
          osmFeatureId("way", p.properties.osmWayId!)
        : osmFeatureId("node", p.properties.osmNodeId),
      properties: p.properties,
      geometry: { type: "Point", coordinates: p.lonLat },
      tippecanoe: { layer: CYCLING_LAYER, minzoom: PARKING_MIN_ZOOM },
    };
}
