// The service plan: the compact, per-feed-version schedule produced by scripts/build-schedule.ts and
// consumed by the browser. See PLAN.md §4.2.

import type { ServiceCalendar } from '../gtfs/calendar.ts';
import type { LonLat } from '../geo.ts';

export type RouteKind = 'skytrain' | 'shape' | 'bus';
export type RouteMode = 'skytrain' | 'ferry' | 'rail' | 'bus';

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
}

export interface FeedManifestEntry {
  version: string;
  start: string;
  end: string;
  path: string;
  builtAt: string;
}

export interface FeedManifest {
  schema: 1;
  generatedAt: string;
  feeds: FeedManifestEntry[];
}

/** The newest feed whose validity range covers the service date. */
export function feedForDate(manifest: FeedManifest, date: string): FeedManifestEntry | undefined {
  let best: FeedManifestEntry | undefined;
  for (const f of manifest.feeds) {
    if (date < f.start || date > f.end) continue;
    if (!best || f.start > best.start || (f.start === best.start && f.version > best.version)) best = f;
  }
  return best;
}

/** Union of all feed ranges, for bounding the date picker. */
export function manifestRange(manifest: FeedManifest): { start: string; end: string } | undefined {
  if (!manifest.feeds.length) return undefined;
  return {
    start: manifest.feeds.reduce((m, f) => (f.start < m ? f.start : m), manifest.feeds[0]!.start),
    end: manifest.feeds.reduce((m, f) => (f.end > m ? f.end : m), manifest.feeds[0]!.end),
  };
}
