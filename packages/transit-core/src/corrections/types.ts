// Observations: ground truth that corrects the schedule-inferred trains (PLAN.md §4.7).
//
// Observations reference stable identifiers: a service date plus a GTFS trip_id, or a stop and a
// time. Never inferred run ids (e.g. "expo-012"), which change whenever runs are rebuilt. Times are
// ISO 8601 with an offset, e.g. "2026-09-28T08:15:30-07:00". Every observation names its source.

export interface Consist {
  /** Vessel or train name, e.g. "Burrard Pacific Breeze". */
  name?: string;
  /** e.g. "Mk V", "Mk III", "Mk I", "Canada Line EMU". */
  type?: string;
  cars?: number;
  /** Car numbers in order, if known. */
  carNumbers?: string[];
}

interface Base {
  /** Service date (YYYY-MM-DD) of the trip the observation is about. */
  date: string;
  /** Who/what reported it, e.g. "rider report", "platform camera", "TransLink alert". */
  source: string;
  note?: string;
}

export type Observation =
  /**
   * The vehicle running `trip` was seen at `stop` (GTFS stop_id or stop name) at `time`. `event`
   * says whether that time is its arrival or departure there (default: while stopped), which matters
   * at termini where one vehicle both arrives and departs.
   */
  | (Base & {
      kind: "at_platform";
      trip?: string;
      stop: string;
      time: string;
      line?: string;
      event?: "arrive" | "depart";
      consist?: Consist;
    })
  /** `trip` ran `seconds` late (+) or early (−) from `time` (default: its start). */
  | (Base & { kind: "delay"; trip: string; seconds: number; time?: string })
  /** `trip` did not run. */
  | (Base & { kind: "cancel"; trip: string })
  /** The train running `trip` is this consist (applies to its whole inferred run). */
  | (Base & { kind: "consist"; trip: string; consist: Consist })
  /**
   * A train standing out of service (e.g. parked on a siding) on the track nearest `at`, seen at
   * `time`. Shown from `from` to `until` (default ±15 min around `time`).
   */
  | (Base & {
      kind: "parked";
      at: [number, number];
      time: string;
      from?: string;
      until?: string;
      line?: string;
      consist?: Consist;
    });

export interface ObservationFile {
  $comment?: string;
  observations: Observation[];
}

/** Published index of observation files by date (public/data/observations/index.json). */
export interface ObservationIndex {
  schema: 1;
  /** Service date (YYYYMMDD) → files (paths relative to public/). */
  byDate: Record<string, string[]>;
}
