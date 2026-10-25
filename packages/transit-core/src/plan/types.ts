// The service plan: the compact, per-feed-version schedule produced by pipelines/build-schedule.ts and
// consumed by the browser. See packages/transit-core/DESIGN.md#timetables.

import type { ServiceDate } from "../time.ts";
import type { ServiceCalendar } from "../gtfs/calendar.ts";
import type { LonLat } from "../geo.ts";
import type { RouteStops } from "../schedule/stops.ts";

export type RouteKind = "skytrain" | "shape" | "bus";
export type RouteMode = "skytrain" | "ferry" | "rail" | "bus";

export interface PlanRoute {
  key: string;
  label: string;
  kind: RouteKind;
  mode: RouteMode;
  /**
   * Drawn in its own colour (its operator's brand) rather than by frequency, unless the viewer has
   * every route coloured by frequency: rail and ferries, and buses routes.json says (the 99 B-Line,
   * RapidBus, Blink). Other buses have no colour of their own (plan/routes.ts).
   */
  brand: boolean;
  color: string;
  textColor: string;
  gtfsRouteId: string;
  /**
   * Dataset registry id of the feed it comes from (@transitopia/shared/datasets.ts), for credits.
   * Absent in plans built before it: hosts pass a default (TransitEngineOptions.dataset).
   */
  dataset?: string | undefined;
  /**
   * How often it runs on regular weekdays (schedule/frequency.ts → `weekdayWait`): the median of
   * each daytime hour's worst wait in its better direction that hour, in minutes. Set when the plan is
   * published; absent when it doesn't run in those hours.
   */
  weekdayWait?: number | undefined;
  /** Its stops: average spacing and its busiest pattern (schedule/stops.ts → `routeStops`). Set when the plan is published. */
  stops?: RouteStops | undefined;
  /**
   * Its scheduled speed on regular weekdays, the slowest and fastest hour from 06:00 to 21:00
   * (km/h, schedule/stops.ts → `weekdaySpeedRange`). Set when the plan is published.
   */
  weekdaySpeed?: [number, number] | undefined;
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

/** A bus exchange, or a station's bus bays. */
export interface PlanHub {
  id: string;
  /** "UBC Exchange", "Kootenay Loop"; a station's name for its bays ("Joyce-Collingwood"). */
  name: string;
  /** Centre of its bays. */
  lon: number;
  lat: number;
  /** GTFS stop_ids of its bays, by bay number. */
  bays: string[];
  /** Route keys serving them. */
  routes: string[];
  /** The plan station whose bays these are; absent for an exchange on its own. */
  station?: string;
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
  /**
   * Per service_id, its trips' start times (seconds since service-day start, sorted): what
   * frequencies are counted from without the trips. Only in a plan whose trips are loaded by
   * service (the browser's, from the published core: plan/published.ts); elsewhere they're the
   * trips' own (`patternStarts`).
   */
  starts?: Record<string, number[]> | undefined;
}

/**
 * A pattern running along a corridor: its index, its direction relative to the corridor's
 * coordinates (1: first to last), and its distance along its shape where it enters the corridor (m).
 */
export type CorridorRef = [pattern: number, dir: 1 | -1, along: number];

/**
 * A stretch of road and the bus patterns running along it (packages/transit-core/DESIGN.md#bus-corridors), as
 * built and as pipelines read it back: the browser draws corridors from the plan's tiles and has only
 * their metadata (`PlanCorridorInfo`).
 */
export interface PlanCorridor {
  coords: LonLat[];
  /** Only while building the plan: a published plan carries its `combo` instead. */
  refs?: CorridorRef[] | undefined;
  /** Its frequency combo (`ServicePlan.frequency`), in a published plan. */
  combo?: number | undefined;
}

/**
 * A plan's corridors without their geometry (packages/transit-core/DESIGN.md#plan-tiles): what the map
 * styles the corridors of its tiles by. A corridor's index is its feature id in the tiles.
 */
export interface CorridorSet {
  /** Per corridor, its frequency combo (`ServicePlan.frequency`). */
  combo: number[];
  /** Short corridors and the corridors they join (`shortCorridorNeighbours`). */
  short: [number, number[]][];
}

/**
 * A stretch of a pattern drawn by one feature of the plan's tiles (a corridor, or a piece of
 * SkyTrain's line): its id, and from and to where along the pattern's shape it runs (m).
 */
export type PathStep = [id: number, from: number, to: number];

/**
 * A pattern's path over the lines drawn for it, in order (packages/transit-core/DESIGN.md#published-plans):
 * the detailed and the overview corridors it runs along, each time it does. For drawing a stretch of
 * a pattern (a combined route) over them.
 */
export interface PatternPath {
  detailed: PathStep[];
  overview: PathStep[];
}

/**
 * Pattern paths are published in files by their route's group: the first character of its key
 * ("99" and "9" together; "R1" to "R6"; "N10" with the other night buses), so a combined route,
 * whose routes are usually numbered alike, needs a file or two.
 */
export function pathGroup(routeKey: string): string {
  const c = routeKey.charAt(0).toLowerCase();
  return /^[0-9a-z]$/.test(c) ? c : "_";
}

/** The detailed corridors (drawn from CORRIDOR_DETAIL_ZOOM) and the overview's (divided roads merged). */
export interface PlanCorridorInfo {
  detailed: CorridorSet;
  overview: CorridorSet;
}

/**
 * What the map's corridors and stop ticks are coloured by, worked out when the plan is published
 * (plan/corridor-frequency.ts): routes by direction, the combinations of them found on corridors
 * and at stops, and each stop's combination.
 */
export interface PlanFrequencyTable {
  routeDirs: { route: string; patterns: number[] }[];
  combos: {
    units: {
      routeDir: number;
      patterns: number[];
      /**
       * In a unit sharing a stretch with others: when each pattern's trips pass here, s after
       * they start, relative to the combo's earliest (for merging their departures).
       */
      offsets?: number[] | undefined;
    }[];
    /** Units (indices into `units`) that share a stretch here, two or more each. */
    bundles: number[][];
    /** Its weekday figure with every route shown (minutes, `PlanRoute.weekdayWait`'s measure). */
    weekday?: number | undefined;
  }[];
  /** Per plan stop, its combo (the routes leaving it). */
  stopCombo: number[];
}

/**
 * Shapes and corridors have this many decimals (about 1 m), which their published coding keeps
 * exactly (plan/published.ts): build-schedule rounds them to it before measuring along them.
 */
export const LINE_DECIMALS = 5;

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

/**
 * Per pattern, per service_id: its trips' start times (s, sorted). From the patterns' `starts`
 * where the plan has them (the browser's, whose trips load by service), else from its trips.
 */
export function patternStarts(
  plan: Pick<ServicePlan, "patterns" | "trips">,
): Record<string, number[]>[] {
  if (plan.patterns.every((p) => p.starts))
    return plan.patterns.map((p) => p.starts!);
  // Per trips array: scenarios and disruptions replace a plan's trips with a new one.
  const cached = startsOfTrips.get(plan.trips);
  if (cached?.length === plan.patterns.length) return cached;
  const out = plan.patterns.map((): Record<string, number[]> => ({}));
  for (const t of plan.trips) (out[t.pattern]![t.service] ??= []).push(t.start);
  for (const byService of out)
    for (const list of Object.values(byService)) list.sort((a, b) => a - b);
  startsOfTrips.set(plan.trips, out);
  return out;
}
const startsOfTrips = new WeakMap<PlanTrip[], Record<string, number[]>[]>();

/** Per pattern, how many trips follow it on any day (`patternStarts`). */
export function patternTripCounts(
  plan: Pick<ServicePlan, "patterns" | "trips">,
): number[] {
  return patternStarts(plan).map((byService) =>
    Object.values(byService).reduce((n, list) => n + list.length, 0),
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
  /**
   * Bus exchanges and stations' bus bays, as the plan's own grouping proposes them (`busHubs`,
   * packages/transit-core/DESIGN.md#bus-exchanges). The site groups by the registry's places file
   * instead where there is one (packages/transit-map/src/hubs.ts).
   */
  hubs: PlanHub[];
  shapes: Record<string, LonLat[]>;
  patterns: PlanPattern[];
  trips: PlanTrip[];
  calendar: ServiceCalendar;
  /** Ferry berth pairs (SeaBus, packages/transit-core/DESIGN.md#seabus-ais); absent for plans built before them. */
  ferry?: FerryBerthPlan;
  /**
   * Bus corridors from road-matched shapes (packages/transit-core/DESIGN.md#bus-corridors). Absent
   * when the feed's roads weren't fetched (fetch-osm-roads), and in plans built before them.
   */
  corridors?: PlanCorridor[];
  /** The same, with the two carriageways of divided roads merged into one line, for zoomed-out views. */
  overviewCorridors?: PlanCorridor[];
  /** The corridors' metadata, in the browser's plan (from its `files.corridorInfo`). */
  corridorInfo?: PlanCorridorInfo | undefined;
  /**
   * Only while building the plan: each bus pattern's path over the corridors (`PatternPath`), by
   * pattern index. Published in files of their own (`PlanFiles.paths`).
   */
  paths?: Map<number, PatternPath> | undefined;
  /** The corridors' and stops' frequency combos, in a published plan with corridors. */
  frequency?: PlanFrequencyTable | undefined;
  /**
   * Where a published plan's other parts are (plan/published.ts): set on the core the browser
   * loads, whose shapes, corridors and trips come from these files.
   */
  files?: PlanFiles | undefined;
}

/** A published plan's files, relative to its plan.json (packages/transit-core/DESIGN.md#published-plans). */
export interface PlanFiles {
  shapes: string;
  corridors?: string | undefined;
  overviewCorridors?: string | undefined;
  /** The corridors' metadata without their geometry (`PlanCorridorInfo`): what the browser loads. */
  corridorInfo?: string | undefined;
  /** Bus patterns' paths over the corridors (`PatternPath`), a file per route group (`pathGroup`). */
  paths?: Record<string, string> | undefined;
  /**
   * SkyTrain patterns' paths over its line pieces in the plan's tiles (`PathStep`s), where the region
   * has track. Set by build-plan-tiles, with the tiles they're numbered by.
   */
  railPaths?: string | undefined;
  /**
   * The plan's tiles (packages/transit-core/DESIGN.md#plan-tiles): every line the map draws for it, named by
   * a hash of their input, so plans whose lines didn't change share them. Set by build-plan-tiles.
   */
  tiles?: string | undefined;
  trips: TripFileRef[];
}

/** One file of a service's trips. */
export interface TripFileRef {
  service: string;
  path: string;
  trips: number;
  /**
   * No trip in it is shown after this (service seconds). A service's trips still running towards
   * midnight are in a late file of their own, and the others' file says 24:00, so the day after
   * needs only the late file.
   */
  until: number;
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
