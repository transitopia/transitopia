// The cycling network from OSM elements, read one at a time (packages/cycling-core/README.md#from-osm):
// every way that's a cycling facility with its attributes, bike parking, and the bike routes.

import { distM, round } from "@transitopia/transit-core/geo.ts";
import { joinChains, type LonLat, type ClassifiedWay } from "./chains.ts";
import {
  classifyWay,
  COMFORT,
  isBikeParking,
  isBikeRoute,
  isFerry,
  type ClassifyConfig,
  type Comfort,
} from "./classify.ts";
import type { OsmElement, OsmWay, Tags } from "./osm.ts";
import type { ComfortLengths, CyclingRoute } from "./routes.ts";
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
  /**
   * A bike route's lines: its ways and its subroutes' that are in the area, each once, joined end to
   * end where only two of them meet.
   */
  routeLines(id: number): LonLat[][];
}

/** Decimals kept in a route's bbox (about a metre). */
const BBOX_DECIMALS = 5;

/**
 * A way any bike route might name: where it is, its length (metres), and its comfort (0 if none)
 * or that it's a ferry crossing.
 */
interface WayInfo {
  id: number;
  nodes: readonly number[];
  coords: readonly LonLat[];
  lengthM: number;
  comfort: Comfort | typeof COMFORT.none | "ferry";
}

function lengthOf(coords: readonly LonLat[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++)
    m += distM(coords[i - 1]!, coords[i]!);
  return m;
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
  /**
   * Every way, for the routes' lengths, bboxes and lines (relations come after ways in OPL, so which
   * ways a route names isn't known until then).
   */
  private readonly wayInfo = new Map<number, WayInfo>();
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
      const cls = canBeLine(e) ? classifyWay(e.tags, this.config) : undefined;
      this.wayInfo.set(e.id, {
        id: e.id,
        nodes: e.nodes,
        coords,
        lengthM: lengthOf(coords),
        comfort: cls?.comfort ?? (isFerry(e.tags) ? "ferry" : COMFORT.none),
      });
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
    const parents = new Map<number, number[]>();
    const ids = [...this.routes.keys()].sort((a, b) => a - b);
    for (const id of ids)
      for (const s of new Set(this.subroutesOf(id))) {
        let l = parents.get(s);
        if (!l) parents.set(s, (l = []));
        l.push(id);
      }
    const routes = new Map<number, CyclingRoute>();
    for (const id of ids) routes.set(id, this.route(id, parents.get(id)));
    return {
      ways: this.ways,
      parking: this.parking,
      routes,
      routeLines: (id) =>
        joinChains(
          this.waysOf(id).map((w) => ({ ...w, attrs: null })),
          () => "",
          () => false,
        ).map((c) => c.coords),
    };
  }

  /** A route's subroutes that are bike routes (not itself), in member order. */
  private subroutesOf(id: number): number[] {
    return this.routes
      .get(id)!
      .subroutes.filter((s) => s !== id && this.routes.has(s));
  }

  /** The ways in the area of a route and its subroutes, theirs, and so on, each once. */
  private waysOf(id: number): WayInfo[] {
    const ways = new Map<number, WayInfo>();
    const seen = new Set<number>();
    const visit = (r: number) => {
      const route = this.routes.get(r);
      // `seen` also stops a route that contains itself, through its subroutes or directly.
      if (!route || seen.has(r)) return;
      seen.add(r);
      for (const w of route.ways) {
        const info = this.wayInfo.get(w);
        if (info) ways.set(w, info);
      }
      for (const s of route.subroutes) visit(s);
    };
    visit(id);
    return [...ways.values()];
  }

  /** A route's summary: its ways and its subroutes' (those that are bike routes), each once. */
  private route(id: number, parents: number[] | undefined): CyclingRoute {
    const { tags } = this.routes.get(id)!;
    const comfortM: ComfortLengths = [0, 0, 0, 0, 0];
    let lengthM = 0;
    let ferryM = 0;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const way of this.waysOf(id)) {
      lengthM += way.lengthM;
      if (way.comfort === "ferry") ferryM += way.lengthM;
      else comfortM[way.comfort] += way.lengthM;
      for (const [lon, lat] of way.coords) {
        [w, s, e, n] = [
          Math.min(w, lon),
          Math.min(s, lat),
          Math.max(e, lon),
          Math.max(n, lat),
        ];
      }
    }
    const r: CyclingRoute = {
      lengthM: Math.round(lengthM),
      comfortM: comfortM.map(Math.round) as ComfortLengths,
    };
    if (ferryM) r.ferryM = Math.round(ferryM);
    if (tags.name !== undefined) r.name = tags.name;
    if (tags.ref !== undefined) r.ref = tags.ref;
    if (tags.network !== undefined) r.network = tags.network;
    const subs = [...new Set(this.subroutesOf(id))];
    if (subs.length) r.subroutes = subs;
    if (parents?.length) r.parents = parents;
    if (w !== Infinity) {
      const d = BBOX_DECIMALS;
      r.bbox = [round(w, d), round(s, d), round(e, d), round(n, d)];
    }
    return r;
  }
}
