// Real-time snapshot format shared by the RT service (server/) and the browser. One snapshot is one
// upstream poll, filtered to our routes. History files store one compact snapshot per line (NDJSON).

export interface RtVehicle {
  /** GTFS-RT vehicle.id (stable fleet identifier). */
  id: string;
  /** vehicle.label, typically the fleet number shown on the bus. */
  label?: string;
  tripId?: string;
  routeKey: string;
  lat: number;
  lon: number;
  bearing?: number;
  /** Epoch ms of the position fix (vehicle timestamp, falling back to the feed header). */
  ts: number;
  stopSeq?: number;
  stopId?: string;
  /** GTFS-RT VehicleStopStatus: 0 incoming, 1 stopped at, 2 in transit to. */
  status?: number;
  /** Seconds late (+) / early (−) at the next stop, from TripUpdates when available. */
  delay?: number;
  /** m/s, when the source reports it (AIS speed over ground). */
  speed?: number;
}

export interface RtSnapshot {
  /** Epoch ms when the service fetched this snapshot. */
  fetchedAt: number;
  /**
   * Epoch ms when this client received it (live view only; not recorded). Fixes count as known from
   * then, so a correction starts from what this client was actually showing.
   */
  receivedAt?: number;
  /** Epoch ms of the upstream feed header timestamp. */
  headerTs: number;
  vehicles: RtVehicle[];
}

/** Response of GET /rt/live. */
export interface RtLiveResponse {
  snapshot: RtSnapshot | null;
  /** Seconds since the snapshot was fetched, at response time. */
  ageS: number | null;
  stale: boolean;
  /** Why data is unavailable (e.g. no API key), for display. */
  error?: string;
  /** Live dispatch (PLAN.md §4.11): service date (YYYYMMDD) → current patch version. */
  dispatch?: Record<string, string>;
}

/** Response of GET /rt/coverage: recorder coverage as merged [start, end] epoch-ms intervals. */
export interface RtCoverageResponse {
  intervals: [number, number][];
}

type Tuple = [
  string,
  string | null,
  string | null,
  string,
  number,
  number,
  number | null,
  number,
  number | null,
  string | null,
  number | null,
  number | null,
  // Optional trailing fields (absent in older recordings).
  number?,
];

/** Compact line format: {t, h, v: tuples}. Positions rounded to ~1 m. */
export function encodeSnapshot(s: RtSnapshot): string {
  return JSON.stringify({
    t: s.fetchedAt,
    h: s.headerTs,
    v: s.vehicles.map((v): Tuple => {
      const row: Tuple = [
        v.id,
        v.label ?? null,
        v.tripId ?? null,
        v.routeKey,
        Math.round(v.lat * 1e5) / 1e5,
        Math.round(v.lon * 1e5) / 1e5,
        v.bearing ?? null,
        v.ts,
        v.stopSeq ?? null,
        v.stopId ?? null,
        v.status ?? null,
        v.delay ?? null,
      ];
      if (v.speed !== undefined) row.push(v.speed);
      return row;
    }),
  });
}

export function decodeSnapshot(line: string): RtSnapshot {
  const o = JSON.parse(line) as { t: number; h: number; v: Tuple[] };
  return {
    fetchedAt: o.t,
    headerTs: o.h,
    vehicles: o.v.map(([id, label, tripId, routeKey, lat, lon, bearing, ts, stopSeq, stopId, status, delay, speed]) => {
      const v: RtVehicle = { id, routeKey, lat, lon, ts };
      if (label !== null) v.label = label;
      if (tripId !== null) v.tripId = tripId;
      if (bearing !== null) v.bearing = bearing;
      if (stopSeq !== null) v.stopSeq = stopSeq;
      if (stopId !== null) v.stopId = stopId;
      if (status !== null) v.status = status;
      if (delay !== null) v.delay = delay;
      if (speed !== undefined && speed !== null) v.speed = speed;
      return v;
    }),
  };
}

/** Merge a point into sorted, non-overlapping coverage intervals (mutates and returns `intervals`). */
export function extendCoverage(intervals: [number, number][], t: number, gapMs: number): [number, number][] {
  const last = intervals[intervals.length - 1];
  if (last && t >= last[0] && t - last[1] <= gapMs) {
    last[1] = Math.max(last[1], t);
  } else if (last && t < last[0]) {
    // Out-of-order point: insert and re-merge (rare; e.g. clock adjustments).
    intervals.push([t, t]);
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const iv of intervals) {
      const m = merged[merged.length - 1];
      if (m && iv[0] - m[1] <= gapMs) m[1] = Math.max(m[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    intervals.length = 0;
    intervals.push(...merged);
  } else {
    intervals.push([t, t]);
  }
  return intervals;
}

export function coverageContains(intervals: [number, number][], t: number, slackMs = 0): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = intervals[mid]!;
    if (t < a - slackMs) hi = mid - 1;
    else if (t > b + slackMs) lo = mid + 1;
    else return true;
  }
  return false;
}
