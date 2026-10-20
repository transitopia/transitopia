// How often something runs, from the timetable (packages/transit-core/DESIGN.md#frequency): the one
// counter behind the route card, the stop cards' rows, the map's bus corridors and stop ticks, and
// the plan's weekday figures. Two numbers: the worst wait, the longest a rider arriving in the window
// could wait, and the average wait of one arriving at a random time. Bands follow the worst wait.

import { indexCalendar } from "../gtfs/calendar.ts";
import { patternStarts, type ServicePlan } from "../plan/types.ts";
import { addDays, dayOfWeek, type ServiceDate } from "../time.ts";
import type { PreparedPlan } from "./engine.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;

/** The route card's day strip: an hour cell from 05:00 to 01:00 (service hours, may exceed 24). */
export const DAY_HOURS: readonly number[] = Array.from(
  { length: 21 },
  (_, i) => 5 + i,
);

/** What the map's bus corridors show: the hour from the shown time, or regular weekdays. */
export type FrequencyWindow = "now" | "day";

/**
 * The weekday figure's hours (from a service day's start): 06:00 to 21:00, the hours most riders
 * travel; later hours are a time on the slider away with "now".
 */
export const DAY_WINDOW = { fromH: 6, toH: 21 } as const;

/**
 * In the weekday figure an hour without service counts as this wait (s), and no hour counts as worse
 * (`worstWait` is at most its window): no bus that hour is at least as bad as hourly service, and a
 * route without Sunday service drops a band rather than to nothing. A presentation choice.
 */
export const NO_SERVICE_WAIT_S = HOUR;

/** How often something runs in a window. */
export interface Frequency {
  /** Worst wait (minutes): the longest a rider arriving in the window could wait (`worstWait`). */
  wait: number;
  /** Average wait (minutes) for a rider arriving at a random time in the window (`averageWait`). */
  averageWait: number;
  departures: number;
}

/**
 * Departures somewhere, as trips by start time: per service_id, sorted start times (service
 * seconds), shifted by `offset` seconds to the time they pass the place counted at (0 at the start).
 */
export interface Starts {
  byService: Readonly<Record<string, ArrayLike<number>>>;
  offset: number;
}

export type ServicesOn = (date: ServiceDate) => Iterable<string>;

/**
 * The longest a rider arriving in [from, to) waits, in seconds: from the window's start to the first
 * departure, between departures, and from the last to the next one after the window, at most the
 * window's length. Where service ends (nothing follows the window's last departure within the
 * window's length: the last train to Braid, or the evening's last bus), the gap after it doesn't
 * count, only the gaps before; with no gap before it either (one last trip), the window counts as
 * one without service. `times` are sorted and include the first departure at or after `to` if there
 * is one. Undefined when nothing departs in the window.
 */
export function worstWait(
  times: ArrayLike<number>,
  from: number,
  to: number,
): number | undefined {
  const window = to - from;
  let i = lowerBound(times, from);
  if (i >= times.length || times[i]! >= to) return undefined;
  let worst = times[i]! - from;
  let gaps = 0;
  for (; i + 1 < times.length && times[i]! < to; i++) {
    const gap = times[i + 1]! - times[i]!;
    // The gap out of the window counts only while service carries on.
    if (times[i + 1]! < to || gap <= window) {
      worst = Math.max(worst, gap);
      gaps++;
    }
  }
  return gaps ? Math.min(worst, window) : window;
}

/** How often departures at sorted `times` run in [from, from + seconds), or undefined when none do. */
export function frequencyOf(
  times: ArrayLike<number>,
  from: number,
  seconds: number,
): Frequency | undefined {
  const to = from + seconds;
  const wait = worstWait(times, from, to);
  if (wait === undefined) return undefined;
  const n = lowerBound(times, to) - lowerBound(times, from);
  return {
    wait: wait / 60,
    averageWait: averageWait(times, from, to)! / 60,
    departures: n,
  };
}

/**
 * The average wait (s) of a rider arriving at a random time in [from, to): over each gap, half of
 * it, weighted by its length, so uneven service waits longer than half the average gap (more riders
 * arrive in the long gaps). As in `worstWait`, after the last departure where service ends nobody
 * is counted, and one last trip counts as no service (half the window). Undefined when nothing
 * departs in the window.
 */
export function averageWait(
  times: ArrayLike<number>,
  from: number,
  to: number,
): number | undefined {
  let i = lowerBound(times, from);
  if (i >= times.length || times[i]! >= to) return undefined;
  // The integral of the wait over arrival times, and how long arrivals are counted for.
  let sum = (times[i]! - from) ** 2 / 2;
  let span = times[i]! - from;
  let gaps = 0;
  for (; i + 1 < times.length && times[i]! < to; i++) {
    const a = times[i]!;
    const b = times[i + 1]!;
    if (b < to) {
      sum += (b - a) ** 2 / 2;
      span += b - a;
      gaps++;
    } else if (b - a <= to - from) {
      // Arrivals until the window's end, for the next departure after it.
      sum += ((b - a) ** 2 - (b - to) ** 2) / 2;
      span += to - a;
      gaps++;
    }
  }
  return gaps ? sum / span : (to - from) / 2;
}

/**
 * The sorted departure times (service seconds of `date`) of `sources` from `from` until `to`, and
 * the first one at or after `to`. The previous service day's trips can run after midnight (times
 * past 24:00), and the next day's before the window ends, so all three are searched.
 */
export function departuresAround(
  servicesOn: ServicesOn,
  sources: readonly Starts[],
  date: ServiceDate,
  from: number,
  to: number,
): number[] {
  const out: number[] = [];
  let next = Infinity;
  for (const k of [-1, 0, 1]) {
    const shift = k * DAY;
    for (const service of servicesOn(addDays(date, k)))
      for (const s of sources) {
        const a = s.byService[service];
        if (!a?.length) continue;
        const d = shift + s.offset;
        const hi = lowerBound(a, to - d);
        for (let i = lowerBound(a, from - d); i < hi; i++) out.push(a[i]! + d);
        if (hi < a.length) next = Math.min(next, a[hi]! + d);
      }
  }
  out.sort((a, b) => a - b);
  if (next < Infinity) out.push(next);
  return out;
}

/** How many departures of `sources` are in [from, to) on a date. */
export function countIn(
  servicesOn: ServicesOn,
  sources: readonly Starts[],
  date: ServiceDate,
  from: number,
  to: number,
): number {
  let n = 0;
  for (const k of [-1, 0, 1])
    for (const service of servicesOn(addDays(date, k)))
      for (const s of sources) {
        const a = s.byService[service];
        if (!a?.length) continue;
        const d = k * DAY + s.offset;
        n += lowerBound(a, to - d) - lowerBound(a, from - d);
      }
  return n;
}

// --- Regular weekdays ---

/**
 * A regular week of the feed, Monday to Sunday: for each weekday, the first date with the set of
 * services that weekday most often has over the feed's validity. Holidays and other one-off days
 * have sets of their own (or a weekday's set on another weekday), so they drop out without a list.
 */
export function regularWeek(
  servicesOn: ServicesOn,
  feedStart: ServiceDate,
  feedEnd: ServiceDate,
): ServiceDate[] {
  const seen: Map<string, { date: ServiceDate; n: number }>[] = Array.from(
    { length: 7 },
    () => new Map(),
  );
  for (let d = feedStart; d <= feedEnd; d = addDays(d, 1)) {
    const key = [...servicesOn(d)].sort().join(",");
    const byKey = seen[dayOfWeek(d)]!;
    const cur = byKey.get(key);
    if (cur) cur.n++;
    else byKey.set(key, { date: d, n: 1 });
  }
  return seen.flatMap((byKey) => {
    let best: { date: ServiceDate; n: number } | undefined;
    for (const v of byKey.values()) if (!best || v.n > best.n) best = v;
    return best ? [best.date] : [];
  });
}

/**
 * The regular week's Monday to Friday (`regularWeek`): what the weekday figure is for. Weekend
 * service, often much less frequent, would set even the most frequent route's band.
 */
export function regularWeekdays(
  servicesOn: ServicesOn,
  feedStart: ServiceDate,
  feedEnd: ServiceDate,
): ServiceDate[] {
  return regularWeek(servicesOn, feedStart, feedEnd).filter(
    (d) => dayOfWeek(d) < 5,
  );
}

/**
 * Each hour of DAY_WINDOW on each of `days`, in order: the worst wait there (s, at most
 * NO_SERVICE_WAIT_S, which an hour without service counts as). Undefined when nothing runs in any
 * of those hours.
 */
export function hourlyWaits(
  servicesOn: ServicesOn,
  days: readonly ServiceDate[],
  sources: readonly Starts[],
): Float64Array | undefined {
  const from = DAY_WINDOW.fromH * HOUR;
  const to = DAY_WINDOW.toH * HOUR;
  const out = new Float64Array(
    days.length * (DAY_WINDOW.toH - DAY_WINDOW.fromH),
  );
  let k = 0;
  let any = false;
  for (const date of days) {
    const times = departuresAround(servicesOn, sources, date, from, to);
    for (let h = from; h < to; h += HOUR) {
      const w = worstWait(times, h, h + HOUR);
      if (w !== undefined) any = true;
      out[k++] = w ?? NO_SERVICE_WAIT_S;
    }
  }
  return any ? out : undefined;
}

/** Hour by hour, the best (shortest) of several `hourlyWaits`; undefined when none has service. */
export function bestHourly(
  options: Iterable<Float64Array | undefined>,
): Float64Array | undefined {
  let out: Float64Array | undefined;
  for (const a of options) {
    if (!a) continue;
    if (!out) out = a.slice();
    else for (let i = 0; i < a.length; i++) out[i] = Math.min(out[i]!, a[i]!);
  }
  return out;
}

/**
 * The weekday figure (minutes) from `hourlyWaits`: their median, so a few bad hours (an evening
 * drop) don't set it, though most hours being bad does.
 */
export function weekdayFigure(
  hourly: Float64Array | undefined,
): number | undefined {
  if (!hourly?.length) return undefined;
  const a = hourly.slice().sort();
  const mid = a.length >> 1;
  return (a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2) / 60;
}

/**
 * The weekday figure (minutes) of the best of several options (a route's directions, or the routes
 * and shared stretches along a corridor): each hour of DAY_WINDOW on each of `days`, the shortest
 * of their worst waits (`bestHourly`), and the median of those (`weekdayFigure`). Undefined when
 * nothing runs in any of those hours.
 */
export function weekdayWait(
  servicesOn: ServicesOn,
  days: readonly ServiceDate[],
  options: readonly (readonly Starts[])[],
): number | undefined {
  return weekdayFigure(
    bestHourly(
      options.map((sources) => hourlyWaits(servicesOn, days, sources)),
    ),
  );
}

/** How many departures of `sources` are in DAY_WINDOW over `days`. */
export function weekdayCount(
  servicesOn: ServicesOn,
  days: readonly ServiceDate[],
  sources: readonly Starts[],
): number {
  return days.reduce(
    (n, date) =>
      n
      + countIn(
        servicesOn,
        sources,
        date,
        DAY_WINDOW.fromH * HOUR,
        DAY_WINDOW.toH * HOUR,
      ),
    0,
  );
}

// --- Routes ---

/**
 * A route's trips by start time in each direction: its patterns' (`ServicePlan.patterns[].starts`,
 * or its trips'). Empty when the plan hasn't the route.
 */
export function routeStarts(
  plan: Pick<ServicePlan, "patterns" | "trips">,
  starts: readonly Record<string, number[]>[],
  routeKey: string,
): Starts[][] {
  const byDir = new Map<number, Starts[]>();
  for (const p of plan.patterns) {
    if (p.route !== routeKey) continue;
    let l = byDir.get(p.direction);
    if (!l) byDir.set(p.direction, (l = []));
    l.push({ byService: starts[p.id]!, offset: 0 });
  }
  return [...byDir.values()];
}

/**
 * The better of a route's directions in a window: the one with the shorter worst wait (the more
 * departures when equal). Each direction is a passenger's choice, and a branching line's trips in
 * one direction all serve its trunk.
 */
export function bestDirection(
  servicesOn: ServicesOn,
  dirs: readonly (readonly Starts[])[],
  date: ServiceDate,
  from: number,
  seconds: number,
): Frequency | undefined {
  let best: Frequency | undefined;
  for (const sources of dirs) {
    const f = frequencyOf(
      departuresAround(servicesOn, sources, date, from, from + seconds),
      from,
      seconds,
    );
    if (
      f
      && (!best
        || f.wait < best.wait
        || (f.wait === best.wait && f.departures > best.departures))
    )
      best = f;
  }
  return best;
}

const routeStartsCache = new WeakMap<ServicePlan, Map<string, Starts[][]>>();

function startsOfRoute(pp: PreparedPlan, routeKey: string): Starts[][] {
  let byRoute = routeStartsCache.get(pp.plan);
  if (!byRoute) routeStartsCache.set(pp.plan, (byRoute = new Map()));
  let dirs = byRoute.get(routeKey);
  if (!dirs) {
    dirs = routeStarts(pp.plan, patternStarts(pp.plan), routeKey);
    byRoute.set(routeKey, dirs);
  }
  return dirs;
}

/**
 * How often a route runs, counted by when its trips start, in the `seconds` from `from` (service
 * seconds) on a date: its better direction (`bestDirection`). The window is a length, not an end,
 * so the result doesn't pick up floating-point error from a fractional `from`.
 */
export function routeFrequency(
  pp: PreparedPlan,
  routeKey: string,
  date: ServiceDate,
  from: number,
  seconds: number,
): Frequency | undefined {
  return bestDirection(
    pp.servicesOn,
    startsOfRoute(pp, routeKey),
    date,
    from,
    seconds,
  );
}

/** How often a route runs in each hour of DAY_HOURS on a date. */
export function hourlyFrequency(
  pp: PreparedPlan,
  routeKey: string,
  date: ServiceDate,
): (Frequency | undefined)[] {
  return DAY_HOURS.map((h) =>
    routeFrequency(pp, routeKey, date, h * HOUR, HOUR),
  );
}

/** A route's weekday figure: its directions' (`weekdayWait`), the better one each hour. */
export function routeWeekdayWait(
  servicesOn: ServicesOn,
  days: readonly ServiceDate[],
  dirs: readonly (readonly Starts[])[],
): number | undefined {
  return weekdayWait(servicesOn, days, dirs);
}

/**
 * Every route's weekday figure (`routeWeekdayWait`, minutes to a tenth), for the published plan
 * (`PlanRoute.weekdayWait`).
 */
export function routeWeekdayWaits(
  plan: Pick<
    ServicePlan,
    "patterns" | "trips" | "routes" | "calendar" | "feedStart" | "feedEnd"
  >,
): Map<string, number> {
  const servicesOn = indexCalendar(plan.calendar);
  const days = regularWeekdays(servicesOn, plan.feedStart, plan.feedEnd);
  const starts = patternStarts(plan);
  const out = new Map<string, number>();
  for (const r of plan.routes) {
    const w = routeWeekdayWait(
      servicesOn,
      days,
      routeStarts(plan, starts, r.key),
    );
    if (w !== undefined) out.set(r.key, Math.round(w * 10) / 10);
  }
  return out;
}

// --- Day types ---

export interface DayType {
  /** A date with this set of services, the first found from the start date. */
  date: ServiceDate;
  /** The services that run (sorted), which is what makes days alike. */
  services: string[];
}

/**
 * The feed's kinds of day, in the order they come from `from` (so the first is that day's): dates
 * alike when the same services run. Looks `days` ahead, within the feed's validity.
 */
export function dayTypes(
  pp: PreparedPlan,
  from: ServiceDate,
  days = 14,
): DayType[] {
  const out: DayType[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (date > pp.plan.feedEnd) break;
    const services = [...pp.servicesOn(date)].sort();
    const key = services.join(",");
    if (!services.length || seen.has(key)) continue;
    seen.add(key);
    out.push({ date, services });
  }
  return out;
}

function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
