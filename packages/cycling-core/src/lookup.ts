// Where the cycling map's OSM features are, for the server's feature resolver
// (packages/cycling-core/README.md#lookup): an OSM ref (`osm-way:<id>`, `osm-node:<id>`,
// `osm-relation:<id>`) → its kind, name and extent, from the latest build, so a link works without
// the map's position and without calling OSM. Written beside the published files, not published.

import {
  chainWayId,
  type BikeParking,
  type CyclingWayProperties,
} from "./tiles.ts";
import type { Chain, LonLat } from "./chains.ts";
import type { CyclingRoutes } from "./published.ts";
import { parseKey } from "@transitopia/shared/features.ts";

/** [west, south, east, north]. */
export type BBox = [number, number, number, number];

/** lookup.json. */
export interface CyclingLookup {
  /**
   * The paths and lanes the tiles carry from CYCLING_DETAIL_ZOOM: their first way by id (their tile
   * id's), extent and name.
   */
  chains: { way: number; bbox: BBox; name?: string }[];
  /** OSM way id → its chain (an index in `chains`). */
  ways: Record<string, number>;
  /** Bike parking by OSM ref (`osm-node:<id>`, `osm-way:<id>`). */
  parking: Record<string, { lonLat: LonLat; name?: string }>;
}

/** A cycling feature an OSM ref names. */
export interface CyclingFeature {
  /**
   * The key the site writes for it, and finds it by in the tiles: for a path, its chain's first way
   * by id, whichever of its ways the ref named (packages/cycling-core/README.md#lookup).
   */
  key: string;
  kind: "cycling-route" | "cycling-way" | "bike-parking";
  name: string | null;
  centroid: LonLat;
  bbox: BBox;
}

/** Coordinates rounded to about 10 cm, as the tiles hold them. */
const round = (x: number) => Math.round(x * 1e6) / 1e6;

function bboxOf(coords: readonly LonLat[]): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of coords) {
    b[0] = Math.min(b[0], lon);
    b[1] = Math.min(b[1], lat);
    b[2] = Math.max(b[2], lon);
    b[3] = Math.max(b[3], lat);
  }
  return b.map(round) as BBox;
}

export function cyclingLookup(
  chains: readonly Chain<CyclingWayProperties>[],
  parking: readonly BikeParking[],
): CyclingLookup {
  const ways: Record<string, number> = {};
  chains.forEach((c, i) => {
    for (const w of c.wayIds) ways[w] = i;
  });
  return {
    chains: chains.map((c) => ({
      way: chainWayId(c),
      bbox: bboxOf(c.coords),
      ...(c.attrs.name ? { name: c.attrs.name } : {}),
    })),
    ways,
    parking: Object.fromEntries(
      parking.map(({ lonLat, properties: p }) => [
        p.osmNodeId === undefined ?
          `osm-way:${p.osmWayId}`
        : `osm-node:${p.osmNodeId}`,
        { lonLat, ...(p.name ? { name: p.name } : {}) },
      ]),
    ),
  };
}

const centre = (b: BBox): LonLat => [
  round((b[0] + b[2]) / 2),
  round((b[1] + b[3]) / 2),
];

/**
 * The cycling feature an OSM ref names: a bike route (from the routes file), a path or lane (the
 * chain one of its ways is in), or bike parking (a node, or a way around an area). Undefined for
 * anything else, and for a route with none of its ways in the area.
 */
export function findCyclingFeature(
  key: string,
  lookup: CyclingLookup,
  routes: CyclingRoutes,
): CyclingFeature | undefined {
  const k = parseKey(key);
  if (k?.form !== "ref" || !/^\d+$/.test(k.value)) return undefined;
  switch (k.scheme) {
    case "osm-relation": {
      const r = routes[k.value];
      return r?.bbox ?
          {
            key: `osm-relation:${k.value}`,
            kind: "cycling-route",
            name: r.name ?? r.ref ?? null,
            centroid: centre(r.bbox),
            bbox: r.bbox,
          }
        : undefined;
    }
    case "osm-node":
    case "osm-way": {
      const p = lookup.parking[`${k.scheme}:${k.value}`];
      if (p)
        return {
          key: `${k.scheme}:${k.value}`,
          kind: "bike-parking",
          name: p.name ?? null,
          centroid: p.lonLat,
          bbox: [...p.lonLat, ...p.lonLat],
        };
      const c = k.scheme === "osm-way" ? lookup.ways[k.value] : undefined;
      const chain = c === undefined ? undefined : lookup.chains[c];
      return chain ?
          {
            key: `osm-way:${chain.way}`,
            kind: "cycling-way",
            name: chain.name ?? null,
            centroid: centre(chain.bbox),
            bbox: chain.bbox,
          }
        : undefined;
    }
    default:
      return undefined;
  }
}
