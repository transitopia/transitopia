// Scenario definitions (PLAN.md §4.8): alternate infrastructure and/or service, as config files in
// data/scenarios/<name>/scenario.json, built by `npm run scenario <name>`.

import type { LonLat } from '../geo.ts';
import type { LineKey, SegmentKind } from '../infra/types.ts';

export interface ScenarioSpec {
  name: string;
  description: string;
  infrastructure?: {
    /** Include OSM track with a future opening_date (data/infrastructure/future.generated.geojson). */
    includeFuture?: boolean;
    /** Lines to assign to included future track. */
    futureLines?: LineKey[];
    /** Extra track: a GeoJSON file (relative to the scenario dir) of LineStrings with CustomTrackProps. */
    customTrack?: string;
    /** OSM way ids to remove from the base network. */
    removeWays?: number[];
  };
  service?: {
    operations: ServiceOperation[];
  };
}

export interface CustomTrackProps {
  kind?: SegmentKind;
  lines?: LineKey[];
  name?: string;
}

export interface NewStation {
  name: string;
  /** A point on the alignment (both platforms are created here; mapping picks the tracks). */
  at: LonLat;
}

export type ServiceOperation =
  /**
   * Extend a line past a terminus through new stations: trips ending at `at` continue through
   * `stations` (in order); trips starting at `at` start from the last new station instead.
   */
  {
    op: 'extend';
    route: string;
    at: string;
    stations: NewStation[];
    /** Extra run time over the physical minimum (default 1.15). */
    padding?: number;
    /** Dwell at each new station, s (default 25). */
    dwell?: number;
  }
  /**
   * Shorten a route: cut every trip at its stop nearest `at`, keeping the part on the side of
   * `keep` (e.g. cut the 99 at Arbutus, keep the UBC side). Trips entirely on the cut side are
   * removed. Kept stops keep their timetabled times.
   */
  | {
      op: 'truncate';
      route: string;
      at: LonLat;
      keep: LonLat;
      /** Max distance from `at` to a route stop to count as the cut stop (m, default 300). */
      radiusM?: number;
      /** Headsign destination for trips that now end at the cut, e.g. "Arbutus Station". */
      terminusName?: string;
    };

/** Published per scenario at public/data/scenarios/<name>/manifest.json. */
export interface ScenarioManifest {
  schema: 1;
  name: string;
  description: string;
  builtAt: string;
  /** Same shape as the main feed manifest, pointing at the scenario's plan. */
  feeds: { version: string; start: string; end: string; path: string; builtAt: string; movements: string }[];
  tracks: string;
}
