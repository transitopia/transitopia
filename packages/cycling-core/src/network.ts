// The cycling network from OSM elements, read one at a time (packages/cycling-core/README.md#from-osm):
// every way that's a cycling facility with its attributes, and bike parking.

import type { LonLat, ClassifiedWay } from "./chains.ts";
import {
  classifyWay,
  isBikeParking,
  isBikeRoute,
  type ClassifyConfig,
} from "./classify.ts";
import type { OsmElement, OsmWay } from "./osm.ts";
import type { BikeParking, CyclingWayProperties } from "./tiles.ts";

export interface CyclingNetwork {
  ways: ClassifiedWay<CyclingWayProperties>[];
  parking: BikeParking[];
}

/** A way's [lon, lat]s if every node has a location (a way missing any is left out). */
function wayCoords(w: OsmWay): LonLat[] | undefined {
  return w.coords.every((c) => c !== undefined) ?
      (w.coords as LonLat[])
    : undefined;
}

const isClosed = (w: OsmWay) =>
  w.nodes.length > 1 && w.nodes[0] === w.nodes.at(-1);

/** A closed way is an area unless area=no, and a line unless area=yes (as OSM tools read them). */
const canBeLine = (w: OsmWay) =>
  (!isClosed(w) || w.tags.area !== "yes") && w.nodes.length >= 2;
const canBeArea = (w: OsmWay) =>
  isClosed(w) && w.tags.area !== "no" && w.nodes.length >= 4;

/** A ring's centroid (planar in lon/lat, which is close enough at the size of bike parking). */
function centroid(ring: readonly LonLat[]): LonLat {
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x0, y0] = ring[i - 1]!;
    const [x1, y1] = ring[i]!;
    const f = x0 * y1 - x1 * y0;
    a += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  if (a === 0) {
    const pts = ring.slice(1);
    return [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ];
  }
  return [x / (3 * a), y / (3 * a)];
}

export class CyclingNetworkBuilder {
  private readonly config: ClassifyConfig;
  private readonly ways: ClassifiedWay<CyclingWayProperties>[] = [];
  private readonly parking: BikeParking[] = [];
  /** Each way's bike route relations (direct members only: a route's subroutes don't name it). */
  private readonly routesOf = new Map<number, Set<number>>();

  constructor(config: ClassifyConfig) {
    this.config = config;
  }

  add(e: OsmElement): void {
    const name = e.tags.name === undefined ? {} : { name: e.tags.name };
    if (e.type === "node") {
      if (isBikeParking(e.tags))
        this.parking.push({
          lonLat: [e.lon, e.lat],
          properties: { amenity: "bicycle_parking", ...name, osmNodeId: e.id },
        });
    } else if (e.type === "way") {
      const coords = wayCoords(e);
      if (!coords) return;
      const cls = canBeLine(e) ? classifyWay(e.tags, this.config) : undefined;
      if (cls)
        this.ways.push({
          id: e.id,
          nodes: e.nodes,
          coords,
          attrs: {
            ...cls,
            ...name,
            ...(e.tags.surface === undefined ?
              {}
            : { surface: e.tags.surface }),
          },
        });
      if (isBikeParking(e.tags) && canBeArea(e))
        this.parking.push({
          lonLat: centroid(coords),
          properties: { amenity: "bicycle_parking", ...name, osmWayId: e.id },
        });
    } else if (isBikeRoute(e.tags)) {
      // Bike parking mapped as a multipolygon relation isn't drawn (none in BC as of 2026-10).
      for (const m of e.members) {
        if (m.type !== "way") continue;
        let set = this.routesOf.get(m.ref);
        if (!set) this.routesOf.set(m.ref, (set = new Set()));
        set.add(e.id);
      }
    }
  }

  /** The network, each way with the bike routes it's part of. */
  build(): CyclingNetwork {
    for (const w of this.ways) {
      const ids = this.routesOf.get(w.id);
      if (ids) w.attrs.routes = [...ids].sort((a, b) => a - b).join(",");
    }
    return { ways: this.ways, parking: this.parking };
  }
}
