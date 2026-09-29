// The service plan: the compact, per-feed-version schedule produced by scripts/build-schedule.ts and
// consumed by the browser. See PLAN.md §4.2.

import type { ServiceCalendar } from "../gtfs/calendar.ts";
import type { LonLat } from "../geo.ts";

export type RouteKind = "skytrain" | "shape" | "bus";
export type RouteMode = "skytrain" | "ferry" | "rail" | "bus";

export interface PlanRoute {
  key: string;
  label: string;
  kind: RouteKind;
  mode: RouteMode;
  color: string;
  textColor: string;
  gtfsRouteId: string;
}

export interface PlanStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
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
  feedVersion: string;
  feedStart: string;
  feedEnd: string;
  timezone: string;
  builtAt: string;
  routes: PlanRoute[];
  stops: PlanStop[];
  stations: PlanStation[];
  shapes: Record<string, LonLat[]>;
  patterns: PlanPattern[];
  trips: PlanTrip[];
  calendar: ServiceCalendar;
  /** Ferry berth pairs (SeaBus, PLAN.md §4.12); absent for plans built before them. */
  ferry?: FerryBerthPlan;
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
  start: string;
  end: string;
  path: string;
  builtAt: string;
  /** Movements index (relative to public/); default data/feeds/<version>/movements/index.json. */
  movements?: string;
}

export interface FeedManifest {
  schema: 1;
  generatedAt: string;
  feeds: FeedManifestEntry[];
}

/** The newest feed whose validity range covers the service date. */
export function feedForDate(
  manifest: FeedManifest,
  date: string,
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
): { start: string; end: string } | undefined {
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
