// Disruptions (docs/skytrain-viz-PLAN.md §4.10–4.11): track out of service and service changes for a period, as
// dispatcher inputs. Written by hand in regions/metro-vancouver/disruptions/*.json, or drafted from TransLink alerts and
// confirmed by a person (alerts don't say which track is closed).

export interface Disruption {
  /** Stable id, e.g. "2026-09-27-canada-brighouse-single-track". */
  id: string;
  /** Who or what reported it, e.g. "TransLink alert". */
  source: string;
  /** Shown to users while it applies, e.g. "Single-tracking between Bridgeport and Richmond-Brighouse". */
  text: string;
  note?: string;
  /** Periods it applies (ISO 8601 with offset). Service after midnight belongs to the previous service day. */
  active: { from: string; until: string }[];
  /** Draft (from an alert) until a person confirms it: drafts aren't applied. */
  status?: "draft" | "confirmed";
  /** Where the alert came from, for drafts. */
  alertId?: string;
  /**
   * One track of a double-track section is out of service. Trains in both directions use the track
   * through `keep` (a platform stop id or name, e.g. "Lansdowne Station @ Platform 1") between the
   * two stations, crossing over wherever the track layout allows. `pinEnds`: the two end stations
   * are single-track too (everyone boards from the open track's platform there); otherwise trains
   * keep their usual platform at the ends and cross over beyond them.
   */
  singleTrack?: {
    line: string;
    between: [string, string];
    keep: string;
    pinEnds?: boolean;
  }[];
  /**
   * Reduced service: trips of `line` (optionally only those serving a station in `between`) run at
   * most every `minS` seconds per direction while the disruption applies; the others are cancelled.
   */
  headway?: { line: string; between?: [string, string]; minS: number }[];
}

export interface DisruptionFile {
  $comment?: string;
  disruptions: Disruption[];
}

/** Published index (var/public/data/disruptions/index.json): service date (YYYYMMDD) → disruption ids. */
export interface DisruptionIndex {
  schema: 1;
  byDate: Record<string, string[]>;
}
