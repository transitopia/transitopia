// The service plan: the compact, per-feed-version schedule produced by pipelines/build-schedule.ts and
// consumed by the browser. See packages/transit-core/DESIGN.md#timetables.

import type { ServiceDate } from "../time.ts";
import type { ServiceCalendar } from "../gtfs/calendar.ts";
import type { LonLat } from "../geo.ts";

export type RouteKind = "skytrain" | "shape" | "bus";
export type RouteMode = "skytrain" | "ferry" | "rail" | "bus";
/** The route's layer in the site's layers panel (config/feeds/<feed>/routes.json → category). */
export type RouteCategory = "rapid" | "frequent" | "regular";

export interface PlanRoute {
  key: string;
  label: string;
  kind: RouteKind;
  mode: RouteMode;
  /** Missing in plans built before categories existed: treat as "rapid". */
  category?: RouteCategory | undefined;
  color: string;
  textColor: string;
  gtfsRouteId: string;
  /**
   * Dataset registry id of the feed it comes from (@transitopia/shared/datasets.ts), for credits.
   * Absent in plans built before it: hosts pass a default (TransitEngineOptions.dataset).
   */
  dataset?: string | undefined;
}

export interface PlanStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** GTFS stop_code: the number on the stop's sign ("50123"). Absent in plans built before it. */
  code?: string;
  /** Parent station stop_id, for platforms. */
  parent?: string;
  /** Platform code/number parsed from the name, e.g. "2" for "… @ Platform 2". */
  platform?: string;
}

export interface PlanStation {
  id: string;
  name: string;
  lon: number;
  lat: number;
  routes: string[];
}

/** A distinct (shape, stop sequence) combination shared by many trips. */
export interface PlanPattern {
  id: number;
  route: string;
  direction: number;
  shape: string;
  /** Indices into ServicePlan.stops. */
  stops: number[];
  /** Distance of each stop along the (simplified) shape, metres. */
  dist: number[];
  /**
   * Per stop, from GTFS pickup_type / drop_off_type: bit STOP_NO_PICKUP = can't board, bit
   * STOP_NO_DROPOFF = can't alight (both: a layover or timing point, e.g. the 99's N Grandview Hwy
   * @ Commercial Dr). Absent when every stop allows both.
   */
  access?: number[];
}

/**
 * A pattern running along a corridor: its index, its direction relative to the corridor's
 * coordinates (1: first to last), and its distance along its shape where it enters the corridor (m).
 */
export type CorridorRef = [pattern: number, dir: 1 | -1, along: number];

/** A stretch of road and the bus patterns running along it (packages/transit-core/DESIGN.md#bus-corridors). */
export interface PlanCorridor {
  coords: LonLat[];
  refs: CorridorRef[];
}

export const STOP_NO_PICKUP = 1;
export const STOP_NO_DROPOFF = 2;

/** Whether passengers can board or alight at stop i of a pattern. */
export function isPassengerStop(p: PlanPattern, i: number): boolean {
  return (
    ((p.access?.[i] ?? 0) & (STOP_NO_PICKUP | STOP_NO_DROPOFF))
    !== (STOP_NO_PICKUP | STOP_NO_DROPOFF)
  );
}

/**
 * Per leg (stop i → i+1): whether passengers can be aboard, i.e. someone could have boarded at or
 * before stop i and alight at or after stop i+1. False for e.g. the run from the last drop-off to a
 * layover stop, or from a layover stop to the first pickup.
 */
export function passengerLegs(p: PlanPattern): boolean[] {
  const n = p.stops.length;
  const canBoard = (i: number) => ((p.access?.[i] ?? 0) & STOP_NO_PICKUP) === 0;
  const canAlight = (i: number) =>
    ((p.access?.[i] ?? 0) & STOP_NO_DROPOFF) === 0;
  const boardedBy: boolean[] = [];
  let any = false;
  for (let i = 0; i < n; i++) boardedBy.push((any ||= canBoard(i)));
  const alightFrom: boolean[] = Array(n).fill(false);
  any = false;
  for (let i = n - 1; i >= 0; i--) alightFrom[i] = any ||= canAlight(i);
  return Array.from(
    { length: n - 1 },
    (_, i) => boardedBy[i]! && alightFrom[i + 1]!,
  );
}

export interface PlanTrip {
  id: string;
  pattern: number;
  service: string;
  block?: string;
  headsign: string;
  /** Scheduled departure from the first stop, seconds since service-day start. */
  start: number;
  /** Arrival offset from `start` at each stop. */
  arr: number[];
  /** Departure offset from `start` at each stop; omitted when identical to `arr`. */
  dep?: number[];
}

export interface ServicePlan {
  schema: 1;
  /** The feed it was built from (config/feeds/<id>/feed.json): its files are under feedDataPath(feed, …). */
  feed: string;
  /** Who runs it ("TransLink"), and the version as shown (feed.json → display.feedVersion; plan/display.ts). */
  agency?: string | undefined;
  feedLabel?: string | undefined;
  /** How its trip ids are shortened for display (feed.json → display.tripId; plan/display.ts). */
  tripIdPattern?: string | undefined;
  feedVersion: string;
  feedStart: ServiceDate;
  feedEnd: ServiceDate;
  timezone: string;
  builtAt: string;
  /**
   * A hash of what built it besides the feed (build-schedule's PLAN_FORMAT and config), so the
   * build redoes a plan when those change. Absent in plans built before it.
   */
  inputs?: string;
  routes: PlanRoute[];
  stops: PlanStop[];
  stations: PlanStation[];
  shapes: Record<string, LonLat[]>;
  patterns: PlanPattern[];
  trips: PlanTrip[];
  calendar: ServiceCalendar;
  /** Ferry berth pairs (SeaBus, packages/transit-core/DESIGN.md#seabus-ais); absent for plans built before them. */
  ferry?: FerryBerthPlan;
  /**
   * The feed's other bus routes, which the map doesn't draw (yet): enough for their cards and for
   * stop cards to list them (packages/transit-core/DESIGN.md#route-catalogue). Absent in plans built
   * before it.
   */
  catalog?: CatalogRoute[];
  /**
   * Bus corridors from road-matched shapes (packages/transit-core/DESIGN.md#bus-corridors). Absent
   * when the feed's roads weren't fetched (fetch-osm-roads), and in plans built before them.
   */
  corridors?: PlanCorridor[];
  /** The same, with the two carriageways of divided roads merged into one line, for zoomed-out views. */
  overviewCorridors?: PlanCorridor[];
}

/**
 * A route in the feed without trips in the plan: what it's called, the plan's stops it serves, and
 * when its trips start, which is all its frequency needs (`routeMinutes`). Category "regular".
 */
export interface CatalogRoute extends PlanRoute {
  /** Stops it serves among the plan's stops (stop_ids). */
  stops: string[];
  /**
   * Per service_id: its trips' start times, minutes after the service day starts (may exceed
   * 24 h), sorted, for direction_id 0 and 1.
   */
  starts: Record<string, [number[], number[]]>;
}

/**
 * A ferry route's berth pairs: every vessel uses one pair all day (e.g. west berth at both
 * terminals). Trips point at the default pair's patterns; a day found (from AIS) to use another
 * pair draws them along that pair's shapes instead.
 */
export interface FerryBerthPlan {
  route: string;
  default: string;
  /** Pair (berth name) → its dock points (one per terminal) and pattern id → shape id. */
  pairs: Record<string, { docks: LonLat[]; shapes: Record<number, string> }>;
}

export interface FeedManifestEntry {
  version: string;
  start: ServiceDate;
  end: ServiceDate;
  /** The plan (relative to the data root): feedDataPath(feed, version, "plan.json"). */
  path: string;
  builtAt: string;
  /** Movements index (relative to the data root), where a scenario has its own; default beside the plan. */
  movements?: string;
}

/** One feed's built versions: data/feeds/<feed>/manifest.json (docs/DESIGN.md#regions-and-feeds). */
export interface FeedManifest {
  schema: 1;
  generatedAt: string;
  feeds: FeedManifestEntry[];
}

/**
 * A feed version as a directory name: GTFS feed_version can be anything, e.g. BC Transit's
 * "202610140/20261013 21:00:00/20261014 04:00:00". TransLink's ("26SEP_20260925") is unchanged.
 */
export function versionDir(feedVersion: string): string {
  const dir = feedVersion.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!dir || dir === "." || dir === "..")
    throw new Error(`Unusable feed version ${JSON.stringify(feedVersion)}`);
  return dir;
}

/** Where a feed's published files live, relative to the data root (URLs and var/public alike). */
export function feedDataPath(
  feed: string,
  feedVersion?: string,
  file?: string,
): string {
  const parts = ["data", "feeds", feed];
  if (feedVersion !== undefined) parts.push(versionDir(feedVersion));
  if (file !== undefined) parts.push(file);
  return parts.join("/");
}

/** Where a region's published files live (infra, observations, dispatch, scenarios), relative to the data root. */
export function regionDataPath(region: string, file?: string): string {
  return [
    "data",
    "regions",
    region,
    ...(file === undefined ? [] : [file]),
  ].join("/");
}

/** The newest feed whose validity range covers the service date. */
export function feedForDate(
  manifest: FeedManifest,
  date: ServiceDate,
): FeedManifestEntry | undefined {
  let best: FeedManifestEntry | undefined;
  for (const f of manifest.feeds) {
    if (date < f.start || date > f.end) continue;
    if (
      !best
      || f.start > best.start
      || (f.start === best.start && f.version > best.version)
    )
      best = f;
  }
  return best;
}

/** Union of all feed ranges, for bounding the date picker. */
export function manifestRange(
  manifest: FeedManifest,
): { start: ServiceDate; end: ServiceDate } | undefined {
  if (!manifest.feeds.length) return undefined;
  return {
    start: manifest.feeds.reduce(
      (m, f) => (f.start < m ? f.start : m),
      manifest.feeds[0]!.start,
    ),
    end: manifest.feeds.reduce(
      (m, f) => (f.end > m ? f.end : m),
      manifest.feeds[0]!.end,
    ),
  };
}
