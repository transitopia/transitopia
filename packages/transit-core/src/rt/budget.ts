// TransLink request budget (regions/metro-vancouver/OPEN-QUESTIONS.md #29): the RT leader polls each GTFS-RT feed on a
// time-of-day schedule that fits a daily request cap, and a rolling 24-hour ledger enforces the cap.
// Thresholds that depend on how often we poll (stale data, recorder coverage, how far apart two fixes
// may be to interpolate between them, how long to predict past the latest fix) follow the schedule
// instead of assuming one fixed interval. Shared by the server, the browser and scripts.

import { dayOfWeek, localDate, toWallTime } from "../time.ts";

export type PollFeed = "positions" | "tripUpdates" | "alerts";
export const POLL_FEEDS: readonly PollFeed[] = [
  "positions",
  "tripUpdates",
  "alerts",
];

/** Poll intervals from `from` (local "HH:MM") until the next band's start. */
export interface PollBand {
  from: string;
  positionsS: number;
  tripUpdatesS: number;
  alertsS: number;
}

export interface PollSchedule {
  /** Requests allowed in any 24 hours, across all feeds. */
  dailyCap: number;
  /** Monday–Friday bands, sorted by `from`, the first at "00:00". */
  weekday: PollBand[];
  /** Saturday and Sunday bands. */
  weekend: PollBand[];
}

const FIELD = {
  positions: "positionsS",
  tripUpdates: "tripUpdatesS",
  alerts: "alertsS",
} as const;
const DAY_MS = 86_400_000;

const minuteOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** The band in effect at t (local time). */
export function bandAt(s: PollSchedule, t: number): PollBand {
  const w = toWallTime(t);
  const bands = dayOfWeek(localDate(t)) >= 5 ? s.weekend : s.weekday;
  const m = w.hour * 60 + w.minute;
  let band = bands[0]!;
  for (const b of bands) if (minuteOfDay(b.from) <= m) band = b;
  return band;
}

/** How often `feed` is polled at t (seconds). */
export function pollIntervalS(
  s: PollSchedule,
  feed: PollFeed,
  t: number,
): number {
  return bandAt(s, t)[FIELD[feed]];
}

/** The longest interval `feed` has anywhere in the schedule (seconds). */
export function maxPollIntervalS(s: PollSchedule, feed: PollFeed): number {
  return Math.max(...[...s.weekday, ...s.weekend].map((b) => b[FIELD[feed]]));
}

const nearMemo = new Map<string, number>();

/**
 * The longest interval `feed` has within twice its maximum interval either side of t, so thresholds
 * derived from it hold across band changes (e.g. the first poll after the peak ends comes 150 s after
 * one polled at a 60 s peak interval). Memoised per minute: it's called every frame.
 */
export function pollIntervalNearS(
  s: PollSchedule,
  feed: PollFeed,
  t: number,
): number {
  const minute = Math.floor(t / 60_000);
  const key = `${scheduleId(s)}:${feed}:${minute}`;
  const hit = nearMemo.get(key);
  if (hit !== undefined) return hit;
  const reach = 2 * maxPollIntervalS(s, feed) * 1000;
  let worst = 0;
  // Bands are at least an hour long; sampling every 5 min (and both ends) sees every band in reach.
  for (
    let x = minute * 60_000 - reach;
    x <= minute * 60_000 + reach + 60_000;
    x += 300_000
  )
    worst = Math.max(worst, pollIntervalS(s, feed, x));
  worst = Math.max(
    worst,
    pollIntervalS(s, feed, minute * 60_000 + reach + 60_000),
  );
  if (nearMemo.size > 2000) nearMemo.clear();
  nearMemo.set(key, worst);
  return worst;
}

const ids = new WeakMap<PollSchedule, number>();
let nextId = 1;
function scheduleId(s: PollSchedule): number {
  let id = ids.get(s);
  if (id === undefined) ids.set(s, (id = nextId++));
  return id;
}

/** Poll times per feed from `from` to `to` following the schedule (each poll waits its interval). */
export function simulatePolls(
  s: PollSchedule,
  from: number,
  to: number,
): Record<PollFeed, number[]> {
  const out = { positions: [], tripUpdates: [], alerts: [] } as Record<
    PollFeed,
    number[]
  >;
  for (const feed of POLL_FEEDS) {
    for (let t = from; t < to; t += pollIntervalS(s, feed, t) * 1000)
      out[feed].push(t);
  }
  return out;
}

/** The most requests the schedule makes in any 24 hours over [from, from + days). */
export function maxRequestsPer24h(
  s: PollSchedule,
  from: number,
  days = 7,
): number {
  const all = Object.values(simulatePolls(s, from, from + days * DAY_MS))
    .flat()
    .sort((a, b) => a - b);
  let worst = 0;
  let lo = 0;
  for (let hi = 0; hi < all.length; hi++) {
    while (all[hi]! - all[lo]! >= DAY_MS) lo++;
    worst = Math.max(worst, hi - lo + 1);
  }
  return worst;
}

/** Requests made in the last 24 hours, to keep under the cap across restarts. */
export class RequestLedger {
  private entries: [number, PollFeed][];

  readonly cap: number;
  readonly windowMs: number;

  constructor(
    cap: number,
    entries: [number, PollFeed][] = [],
    windowMs = DAY_MS,
  ) {
    this.cap = cap;
    this.windowMs = windowMs;
    this.entries = entries
      .filter(
        (e) =>
          Array.isArray(e)
          && typeof e[0] === "number"
          && POLL_FEEDS.includes(e[1]),
      )
      .sort((a, b) => a[0] - b[0]);
  }

  private prune(t: number): void {
    let i = 0;
    while (i < this.entries.length && this.entries[i]![0] <= t - this.windowMs)
      i++;
    if (i) this.entries.splice(0, i);
  }

  record(feed: PollFeed, t: number): void {
    this.entries.push([t, feed]);
    this.prune(t);
  }

  /** Requests in the 24 hours up to t. */
  count(t: number): number {
    this.prune(t);
    return this.entries.length;
  }

  /** The earliest time at or after t when another request stays within the cap. */
  nextAllowedAt(t: number): number {
    const n = this.count(t);
    return n < this.cap ? t : this.entries[n - this.cap]![0] + this.windowMs;
  }

  lastAt(feed: PollFeed): number | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--)
      if (this.entries[i]![1] === feed) return this.entries[i]![0];
    return undefined;
  }

  toJSON(): { requests: [number, PollFeed][] } {
    return { requests: this.entries };
  }
}

/** rt.json settings for thresholds that follow the poll schedule. */
export interface CadenceConfig {
  poll: PollSchedule;
  staleGraceS: number;
  coverageSlackS: number;
  interpolateSlackS: number;
  extrapolateSlackS: number;
}

export interface Cadence {
  /** Live data fetched at `fetchedAt` is stale this long after it (ms). */
  staleAfterMs(fetchedAt: number): number;
  /** Recorder coverage continues across gaps up to this long at t (ms). */
  coverageGapMs(t: number): number;
  /** Interpolate between two fixes of a vehicle at most this far apart, around t (s). */
  maxInterpolateS(t: number): number;
  /** Predict a vehicle forward for at most this long after its fix at t (s). */
  maxExtrapolateS(t: number): number;
  /** The largest maxInterpolateS anywhere in the schedule (s): how much history to load around t. */
  maxInterpolateLimitS: number;
  /** An alert last seen at t still counts this much later (it's polled only this often) (ms). */
  alertGraceMs(t: number): number;
}

export function cadence(cfg: CadenceConfig): Cadence {
  const near = (feed: PollFeed, t: number) =>
    pollIntervalNearS(cfg.poll, feed, t);
  return {
    staleAfterMs: (fetchedAt) =>
      (near("positions", fetchedAt) + cfg.staleGraceS) * 1000,
    coverageGapMs: (t) => (near("positions", t) + cfg.coverageSlackS) * 1000,
    maxInterpolateS: (t) => near("positions", t) + cfg.interpolateSlackS,
    maxExtrapolateS: (t) => near("positions", t) + cfg.extrapolateSlackS,
    maxInterpolateLimitS:
      maxPollIntervalS(cfg.poll, "positions") + cfg.interpolateSlackS,
    alertGraceMs: (t) => near("alerts", t) * 1000,
  };
}
