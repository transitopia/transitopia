// Per-route statistics for one service date (V2-PLAN.md §4.4), from observed stop times, the
// timetable, cancellations and the recorder's coverage. Rows are per route, direction and time
// band (a trip belongs to the band of its first departure), plus "day" for the whole date.
//
// Coverage is the denominator: every rate counts only trips the recorder covered (it was running
// for at least `minTripCoverage` of the trip's scheduled span), and each row says how much was
// covered, so a gap in recording is reported as a gap, never as zeros.

import { coverageContains } from "./types.ts";

export const STATS_VERSION = 1;

export interface StatsConfig {
  /** Early and late limits for "on time" at timepoints (s; decided: −60 to +180). */
  onTimeS: [number, number];
  /** Observed times less precise than this (s) don't count towards punctuality or headways. */
  maxPrecisionS: number;
  /** A trip counts as covered when the recorder ran for at least this share of its span. */
  minTripCoverage: number;
  /** A delivered gap shorter than this share of the scheduled gap is bunching. */
  bunchingShare: number;
  /** Time bands by scheduled first departure (seconds since the service day's start). */
  bands: { id: string; fromS: number; toS: number }[];
}

export interface ScheduledTrip {
  tripId: string;
  routeId: string;
  routeShortName?: string | undefined;
  directionId: number;
  firstDepS: number;
  lastArrS: number;
  /** Departures at every stop (for headways at the reference stop). */
  stops: { stopId: string; schedS: number; timepoint: boolean }[];
}

export interface ObservedRow {
  tripId: string;
  stopId: string;
  schedS: number;
  timepoint: boolean;
  /** Epoch ms. */
  observedAt: number;
  precisionS: number;
}

export interface StatsInput {
  /** Epoch ms of the service day's start (GTFS time 0). */
  dayStart: number;
  trips: ScheduledTrip[];
  observed: ObservedRow[];
  cancelled: Set<string>;
  /** trip_id → number of stops skipped. */
  skipped: Map<string, number>;
  /** Recorder coverage, merged [start, end] epoch-ms intervals. */
  coverage: [number, number][];
  /** How far apart two polls may be and still count as continuous recording (ms). */
  coverageSlackMs: number;
}

export interface RouteStats {
  routeId: string;
  routeShortName?: string | undefined;
  directionId: number;
  band: string;
  /** Mean share of the scheduled trips' spans the recorder covered (0–1). */
  coverage: number;
  metrics: {
    tripsScheduled: number;
    tripsCovered: number;
    tripsObserved: number;
    tripsCancelled: number;
    stopsSkipped: number;
    timepoints: number;
    onTime: number | null;
    early: number | null;
    late: number | null;
    delayP50S: number | null;
    delayP90S: number | null;
    headwayStopId: string | null;
    headwaysDelivered: number;
    scheduledGapP90S: number | null;
    deliveredGapP90S: number | null;
    bunching: number | null;
  };
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

const round = (x: number | null, digits = 3) =>
  x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits;

/** Share of [a, b] (epoch ms) inside the coverage intervals. */
function coveredShare(
  cov: [number, number][],
  a: number,
  b: number,
  slackMs: number,
): number {
  if (b <= a) return coverageContains(cov, a, slackMs) ? 1 : 0;
  let inside = 0;
  for (const [s, e] of cov) {
    const lo = Math.max(a, s - slackMs);
    const hi = Math.min(b, e + slackMs);
    if (hi > lo) inside += hi - lo;
  }
  return Math.min(1, inside / (b - a));
}

export function routeStats(input: StatsInput, cfg: StatsConfig): RouteStats[] {
  const obsByTrip = new Map<string, ObservedRow[]>();
  for (const o of input.observed) {
    let l = obsByTrip.get(o.tripId);
    if (!l) obsByTrip.set(o.tripId, (l = []));
    l.push(o);
  }
  const groups = new Map<string, ScheduledTrip[]>();
  for (const t of input.trips) {
    const key = `${t.routeId}|${t.directionId}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(t);
  }
  const bandOf = (s: number) =>
    cfg.bands.find((b) => s >= b.fromS && s < b.toS)?.id;
  const out: RouteStats[] = [];
  for (const trips of groups.values()) {
    const first = trips[0]!;
    const covered = new Map<string, number>();
    for (const t of trips)
      covered.set(
        t.tripId,
        coveredShare(
          input.coverage,
          input.dayStart + t.firstDepS * 1000,
          input.dayStart + t.lastArrS * 1000,
          input.coverageSlackMs,
        ),
      );
    const isCovered = (t: ScheduledTrip) =>
      covered.get(t.tripId)! >= cfg.minTripCoverage;
    // Headways at the stop with the most usable observations for this route and direction.
    const stopCounts = new Map<string, number>();
    for (const t of trips)
      for (const o of obsByTrip.get(t.tripId) ?? [])
        if (o.precisionS <= cfg.maxPrecisionS)
          stopCounts.set(o.stopId, (stopCounts.get(o.stopId) ?? 0) + 1);
    const refStop = [...stopCounts].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0]?.[0];
    const bands = ["day", ...cfg.bands.map((b) => b.id)];
    for (const band of bands) {
      const inBand = trips.filter(
        (t) => band === "day" || bandOf(t.firstDepS) === band,
      );
      if (!inBand.length) continue;
      const cov = inBand.filter(isCovered);
      const delays: number[] = [];
      for (const t of cov)
        for (const o of obsByTrip.get(t.tripId) ?? [])
          if (o.timepoint && o.precisionS <= cfg.maxPrecisionS)
            delays.push(
              (o.observedAt - (input.dayStart + o.schedS * 1000)) / 1000,
            );
      delays.sort((a, b) => a - b);
      const [early, late] = cfg.onTimeS;
      const share = (f: (d: number) => boolean) =>
        delays.length ? round(delays.filter(f).length / delays.length) : null;
      // Headways: consecutive departures at the reference stop, scheduled and delivered.
      const sched: number[] = [];
      const delivered: number[] = [];
      let bunched = 0;
      if (refStop) {
        const schedTimes = inBand
          .flatMap((t) =>
            t.stops.filter((s) => s.stopId === refStop).map((s) => s.schedS),
          )
          .sort((a, b) => a - b);
        for (let i = 1; i < schedTimes.length; i++)
          sched.push(schedTimes[i]! - schedTimes[i - 1]!);
        const medianSched = quantile(
          [...sched].sort((a, b) => a - b),
          0.5,
        );
        const obsTimes = cov
          .flatMap((t) =>
            (obsByTrip.get(t.tripId) ?? []).filter(
              (o) => o.stopId === refStop && o.precisionS <= cfg.maxPrecisionS,
            ),
          )
          .map((o) => o.observedAt)
          .sort((a, b) => a - b);
        for (let i = 1; i < obsTimes.length; i++) {
          const a = obsTimes[i - 1]!;
          const b = obsTimes[i]!;
          // Only gaps the recorder saw all of.
          if (coveredShare(input.coverage, a, b, input.coverageSlackMs) < 1)
            continue;
          const gap = (b - a) / 1000;
          delivered.push(gap);
          if (medianSched && gap < cfg.bunchingShare * medianSched) bunched++;
        }
      }
      sched.sort((a, b) => a - b);
      delivered.sort((a, b) => a - b);
      out.push({
        routeId: first.routeId,
        routeShortName: first.routeShortName,
        directionId: first.directionId,
        band,
        coverage: round(
          inBand.reduce((s, t) => s + covered.get(t.tripId)!, 0)
            / inBand.length,
        )!,
        metrics: {
          tripsScheduled: inBand.length,
          tripsCovered: cov.length,
          tripsObserved: cov.filter((t) => obsByTrip.has(t.tripId)).length,
          tripsCancelled: inBand.filter((t) => input.cancelled.has(t.tripId))
            .length,
          stopsSkipped: inBand.reduce(
            (s, t) => s + (input.skipped.get(t.tripId) ?? 0),
            0,
          ),
          timepoints: delays.length,
          onTime: share((d) => d >= early && d <= late),
          early: share((d) => d < early),
          late: share((d) => d > late),
          delayP50S: round(quantile(delays, 0.5), 0),
          delayP90S: round(quantile(delays, 0.9), 0),
          headwayStopId: refStop ?? null,
          headwaysDelivered: delivered.length,
          scheduledGapP90S: round(quantile(sched, 0.9), 0),
          deliveredGapP90S: round(quantile(delivered, 0.9), 0),
          bunching: delivered.length ? round(bunched / delivered.length) : null,
        },
      });
    }
  }
  return out;
}
