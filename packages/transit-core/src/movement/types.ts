// Movement files: the inferred physical train runs for one service-day type (a distinct set of
// active GTFS service_ids), built by pipelines/build-movements.ts and played back in the browser
// (docs/skytrain-viz-PLAN.md §4.3–4.4). Times are GTFS service-day seconds.
//
// To stay small, revenue trips are stored by reference: their times come from the service plan and
// their track paths from `patterns` (one routed path per stop-to-stop hop). Only deadheads, turnbacks
// and holds are stored explicitly, plus the times of trips the dispatcher changed (docs/skytrain-viz-PLAN.md §4.11).

import type { ParkedTrain } from "../corrections/reconcile.ts";

/** Flattened path: [segIndex, fromOffset, toOffset, segIndex, fromOffset, toOffset, …]. */
export type PackedPath = number[];

export type MoveKind = "pullout" | "pullin" | "turnback";
/** `signal`: stopped by the dispatcher for a train ahead, a junction, or a single-track section. */
export type HoldKind = "layover" | "yard" | "signal";

/**
 * A dispatched hop's trajectory where it left its planned profile (slowed or stopped by signals):
 * flattened [t, d, t, d, …] from departure to arrival, d in metres along the hop's path. Playback
 * interpolates linearly between the points (kept within ~2 m of the simulated motion).
 */
export interface HopVia {
  hop: number;
  pts: number[];
}

/** A stop between stations (dispatcher: waiting at a signal), `d` metres along the hop's path. */
export interface HopWait {
  hop: number;
  d: number;
  t0: number;
  t1: number;
  why: string;
}

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
   * than the GTFS platform (stub termini: reverse in place, alternate between tracks). `times`
   * (flattened arrival/departure per stop, service-day seconds) and `waits` are set when the
   * dispatcher moved the trip off its plan times.
   */
  | {
      k: "trip";
      trip: string;
      pattern: number;
      berth?: Berth;
      arrive?: Berth;
      times?: number[];
      waits?: HopWait[];
      via?: HopVia[];
    }
  /**
   * Movement along a path between t0 and t1, split into sub-moves at reversals. `via`/`waits`: the
   * dispatcher's trajectory when the move left its planned profile (hop index 0).
   */
  | {
      k: "move";
      t0: number;
      t1: number;
      path: number;
      kind: MoveKind;
      via?: number[];
      waits?: HopWait[];
    }
  /** Standing still at a track position. */
  | {
      k: "hold";
      t0: number;
      t1: number;
      seg: number;
      offset: number;
      dir: 1 | -1;
      kind: HoldKind;
      why?: string;
    };

export interface Run {
  id: string;
  /** Line of the first trip (runs may interline within a fleet). */
  line: string;
  /** Consist placeholder for future data (docs/skytrain-viz-PLAN.md §4.3 step 4). */
  consist?: { type?: string; cars?: number; carNumbers?: string[] };
  events: RunEvent[];
  /** Yard the run starts from / ends at (segment index of the yard lead), if any. */
  fromYard?: string;
  toYard?: string;
  /** Observation instants that anchored this run (dispatch with observations). */
  observed?: { t: number; source: string }[];
  /** Service-day spans where the run's times differ from the base plan because of dispatch inputs. */
  adjusted?: [number, number][];
  /** Sources of the inputs that changed or anchored this run. */
  sources?: string[];
  /** Trips reported cancelled: the train is hidden while running them. */
  cancelled?: string[];
  /** Notices for this train while they apply (e.g. a disruption on its line), service-day seconds. */
  notes?: { t0: number; t1: number; text: string }[];
}

export interface PatternPaths {
  /** Path index for each hop (stop i → i+1). */
  hops: number[];
}

export interface MovementsFile {
  /** 1: timetable positions only; 2: dispatched (signalling-aware, docs/skytrain-viz-PLAN.md §4.11). */
  schema: 1 | 2;
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
    termini: Record<
      string,
      { chained: number; unchained: number; reasons: Record<string, number> }
    >;
  };
  /** Set when the file was produced by the dispatcher. */
  dispatch?: DispatchSummary;
  /** Out-of-service trains seen standing somewhere (observations), shown around their sighting. */
  parked?: ParkedTrain[];
}

export interface DispatchSummary {
  /** Service date the inputs applied to, if any (base plans have none). */
  date?: string;
  /** Inputs used, for display ("3 observations, 1 disruption"). */
  inputs: string[];
  /** Per line: delay added at trip ends against the timetable (s). */
  delay: Record<
    string,
    { trips: number; late: number; median: number; p95: number; max: number }
  >;
  /** Signal holds by place (station or nearest station) and reason. */
  holds: Record<string, number>;
  /** Times the dispatcher had to break a deadlock (a train given authority despite a conflict). */
  forced: { run: string; t: number; where: string; why: string }[];
  ms: number;
}

export interface MovementsIndex {
  schema: 1;
  feedVersion: string;
  /** Service-set key ("1+1101") → file path relative to public/. */
  files: Record<string, string>;
}

export function serviceKey(services: Iterable<string>): string {
  return [...services].sort().join("+");
}
