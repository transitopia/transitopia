// The cycling network from OSM elements, read one at a time (packages/cycling-core/README.md#from-osm):
// every way that's a cycling facility with its attributes, bike parking, and the bike routes.

import { distM, round } from "@transitopia/transit-core/geo.ts";
import type { LonLat, ClassifiedWay } from "./chains.ts";
import {
  classifyWay,
  isBikeParking,
  isBikeRoute,
  type ClassifyConfig,
} from "./classify.ts";
import type { OsmElement, OsmWay, Tags } from "./osm.ts";
import type { CyclingRoute } from "./published.ts";
import type {
  BikeParking,
  BikeParkingProperties,
  CyclingWayProperties,
} from "./tiles.ts";

export interface CyclingNetwork {
  ways: ClassifiedWay<CyclingWayProperties>[];
  parking: BikeParking[];
  /** The bike routes by relation id, in ascending order. */
  routes: Map<number, CyclingRoute>;
}

/** Decimals kept in a route's bbox (about a metre). */
const BBOX_DECIMALS = 5;

/** A way's length (metres) and [west, south, east, north]. */
type Extent = [number, number, number, number, number];

function extentOf(coords: readonly LonLat[]): Extent {
  const e: Extent = [0, Infinity, Infinity, -Infinity, -Infinity];
  for (const [i, c] of coords.entries()) {
    if (i > 0) e[0] += distM(coords[i - 1]!, c);
    e[1] = Math.min(e[1], c[0]);
    e[2] = Math.min(e[2], c[1]);
    e[3] = Math.max(e[3], c[0]);
    e[4] = Math.max(e[4], c[1]);
  }
  return e;
}

/** yes, partial, … → true; no → false. */
const yesNo = (v: string | undefined) =>
  v === undefined ? undefined : v !== "no";

/** Bike parking's details from its tags (https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dbicycle_parking). */
function parkingProperties(
  t: Tags,
  id: { osmNodeId: number } | { osmWayId: number },
): BikeParkingProperties {
  const p: BikeParkingProperties = { amenity: "bicycle_parking" };
  if (t.name !== undefined) p.name = t.name;
  if (t.bicycle_parking !== undefined) p.bicycle_parking = t.bicycle_parking;
  // Only a plain number: "10;5", "~20" and the like are left out.
  if (t.capacity !== undefined && /^\d+$/.test(t.capacity))
    p.capacity = Number(t.capacity);
  const covered = yesNo(t.covered);
  if (covered !== undefined) p.covered = covered;
  const indoor = yesNo(t.indoor);
  if (indoor !== undefined) p.indoor = indoor;
  if (t.operator !== undefined) p.operator = t.operator;
  return { ...p, ...id };
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
  /** Every way's extent, for the routes' lengths and bboxes (relations come after ways in OPL). */
  private readonly extents = new Map<number, Extent>();
  private readonly routes = new Map<
    number,
    { tags: Tags; ways: number[]; subroutes: number[] }
  >();

  constructor(config: ClassifyConfig) {
    this.config = config;
  }

  add(e: OsmElement): void {
    const name = e.tags.name === undefined ? {} : { name: e.tags.name };
    if (e.type === "node") {
      if (isBikeParking(e.tags))
        this.parking.push({
          lonLat: [e.lon, e.lat],
          properties: parkingProperties(e.tags, { osmNodeId: e.id }),
        });
    } else if (e.type === "way") {
      const coords = wayCoords(e);
      if (!coords) return;
      this.extents.set(e.id, extentOf(coords));
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
          properties: parkingProperties(e.tags, { osmWayId: e.id }),
        });
    } else if (isBikeRoute(e.tags)) {
      // Bike parking mapped as a multipolygon relation isn't drawn (none in BC as of 2026-10).
      const route = {
        tags: e.tags,
        ways: [] as number[],
        subroutes: [] as number[],
      };
      this.routes.set(e.id, route);
      for (const m of e.members) {
        if (m.type === "relation") route.subroutes.push(m.ref);
        if (m.type !== "way") continue;
        route.ways.push(m.ref);
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
    const routes = new Map<number, CyclingRoute>();
    for (const id of [...this.routes.keys()].sort((a, b) => a - b))
      routes.set(id, this.route(id));
    return { ways: this.ways, parking: this.parking, routes };
  }

  /** A route's summary: its ways and its subroutes' (those that are bike routes), each once. */
  private route(id: number): CyclingRoute {
    const { tags, subroutes } = this.routes.get(id)!;
    const ways = new Set<number>();
    const seen = new Set<number>();
    const visit = (r: number) => {
      const route = this.routes.get(r);
      if (!route || seen.has(r)) return;
      seen.add(r);
      for (const w of route.ways) ways.add(w);
      for (const s of route.subroutes) visit(s);
    };
    visit(id);
    let lengthM = 0;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const way of ways) {
      const x = this.extents.get(way);
      if (!x) continue;
      lengthM += x[0];
      [w, s, e, n] = [
        Math.min(w, x[1]),
        Math.min(s, x[2]),
        Math.max(e, x[3]),
        Math.max(n, x[4]),
      ];
    }
    const r: CyclingRoute = { lengthM: Math.round(lengthM) };
    if (tags.name !== undefined) r.name = tags.name;
    if (tags.ref !== undefined) r.ref = tags.ref;
    if (tags.network !== undefined) r.network = tags.network;
    const subs = subroutes.filter((s) => this.routes.has(s));
    if (subs.length) r.subroutes = subs;
    if (w !== Infinity) {
      const d = BBOX_DECIMALS;
      r.bbox = [round(w, d), round(s, d), round(e, d), round(n, d)];
    }
    return r;
  }
}
