// Bike routes (packages/cycling-core/README.md#bike-routes): OSM route and superroute relations, as
// the build summarises them (var/cycling/<area>/routes.json, which the server loads into the
// database) and as the server's GET /cycling/routes/<key> answers for a route card.

/** [west, south, east, north]. */
export type BBox = [number, number, number, number];

/** Metres at each comfort level, indexed by comfort: 0 (no bike facility, COMFORT.none) to 4. */
export type ComfortLengths = [number, number, number, number, number];

/** A bike route: an OSM route relation (`type=route|superroute` + `route=bicycle`). */
export interface CyclingRoute {
  name?: string;
  ref?: string;
  /** OSM's `network`: lcn, rcn, ncn or icn (local, regional, national, international), or a list for a route for several modes (`nwn;ncn`). */
  network?: string;
  /** The bike routes it contains, by relation id, in member order. */
  subroutes?: number[];
  /** The bike routes that contain it, by relation id, ascending. */
  parents?: number[];
  /** [west, south, east, north] of its ways, and its subroutes'; none when none are in the area. */
  bbox?: BBox;
  /** The length of its ways and its subroutes' (each counted once), in metres. */
  lengthM: number;
  /** `lengthM` by the comfort of each way (packages/cycling-core/src/classify.ts), ferries aside. */
  comfortM: ComfortLengths;
  /** The length of its ferry crossings (`route=ferry` ways), in `lengthM` but not `comfortM`; none if 0. */
  ferryM?: number;
}

/** var/cycling/<area>/routes.json: an area's bike routes from one build, by relation id. */
export interface CyclingRoutesFile {
  area: string;
  /** The OSM file they were built from (data/osm/<area>/<file>), and when its data is from. */
  osm: { file: string; timestamp: string };
  builtAt: string;
  routes: Record<string, CyclingRoute>;
}

/** Another bike route a route card links to: one that contains it, or one it contains. */
export interface CyclingRouteLink {
  /** Its feature key: a `cr` ID with its name suffix. */
  key: string;
  osmRelation: number;
  name: string;
  network: string | null;
}

/** GET /cycling/routes/<key> (apps/server/README.md#cycling-routes): a route card's data. */
export interface CyclingRouteDetail extends CyclingRouteLink {
  ref: string | null;
  bbox: BBox | null;
  lengthM: number;
  comfortM: ComfortLengths;
  ferryM: number;
  /** The routes that contain it directly. */
  parents: CyclingRouteLink[];
  /** Every route that contains it, nearest first (its parents, theirs, …), each once. */
  ancestors: CyclingRouteLink[];
  /** The routes it contains directly, in member order. */
  subroutes: CyclingRouteLink[];
  /** When the build it's from was made. */
  builtAt: string;
}

/** A route's name, or its ref. */
export const routeTitle = (r: { name?: string | null; ref?: string | null }) =>
  r.name ?? r.ref ?? "Bike route";
