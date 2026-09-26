// Movement files: the inferred physical train runs for one service-day type (a distinct set of
// active GTFS service_ids), built by scripts/build-movements.ts and played back in the browser
// (PLAN.md §4.3–4.4). Times are GTFS service-day seconds.
//
// To stay small, revenue trips are stored by reference: their times come from the service plan and
// their track paths from `patterns` (one routed path per stop-to-stop hop). Only deadheads, turnbacks
// and holds are stored explicitly.

/** Flattened path: [segIndex, fromOffset, toOffset, segIndex, fromOffset, toOffset, …]. */
export type PackedPath = number[];

export type MoveKind = 'pullout' | 'pullin' | 'turnback';
export type HoldKind = 'layover' | 'yard';

/** An alternative track position for a trip's first (berth) or last (arrive) stop, with its hop path. */
export interface Berth {
  seg: number;
  offset: number;
  dir: 1 | -1;
  hop: number;
}

export type RunEvent =
  /**
   * A revenue trip: times from the plan, hop paths from `patterns[pattern]`. `berth` / `arrive`
   * replace the first / last stop's track position and hop when the train uses a different berth
   * than the GTFS platform (stub termini: reverse in place, alternate between tracks).
   */
  | { k: 'trip'; trip: string; pattern: number; berth?: Berth; arrive?: Berth }
  /** Movement along a path between t0 and t1, split into sub-moves at reversals. */
  | { k: 'move'; t0: number; t1: number; path: number; kind: MoveKind }
  /** Standing still at a track position. */
  | { k: 'hold'; t0: number; t1: number; seg: number; offset: number; dir: 1 | -1; kind: HoldKind };

export interface Run {
  id: string;
  /** Line of the first trip (runs may interline within a fleet). */
  line: string;
  /** Consist placeholder for future data (PLAN.md §4.3 step 4). */
  consist?: { type?: string; cars?: number; carNumbers?: string[] };
  events: RunEvent[];
  /** Yard the run starts from / ends at (segment index of the yard lead), if any. */
  fromYard?: string;
  toYard?: string;
}

export interface PatternPaths {
  /** Path index for each hop (stop i → i+1). */
  hops: number[];
}

export interface MovementsFile {
  schema: 1;
  feedVersion: string;
  /** Sorted active service_ids this file is for. */
  services: string[];
  builtAt: string;
  segIds: string[];
  paths: PackedPath[];
  patterns: Record<string, PatternPaths>;
  runs: Run[];
  stats: {
    trips: number;
    runs: number;
    /** Maximum trains in service (on a revenue trip or turning back) per line. */
    peakInService: Record<string, number>;
    unplacedTrips: number;
    /** Per terminus station: arrivals chained to a next trip, and why the others weren't. */
    termini: Record<string, { chained: number; unchained: number; reasons: Record<string, number> }>;
  };
}

export interface MovementsIndex {
  schema: 1;
  feedVersion: string;
  /** Service-set key ("1+1101") → file path relative to public/. */
  files: Record<string, string>;
}

export function serviceKey(services: Iterable<string>): string {
  return [...services].sort().join('+');
}
