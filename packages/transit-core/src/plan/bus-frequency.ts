// How often each bus pattern runs (packages/transit-core/DESIGN.md#bus-corridors): trips an hour,
// counted by when they start, in the hour from a time ("now") or averaged over the day
// (06:00–21:00). Counting by start, as the route card does (schedule/frequency.ts), gives a route
// the same count all along it; plan/corridor-frequency.ts combines these into what the map shows.

import { indexCalendar } from "../gtfs/calendar.ts";
import { addDays, type ServiceDate } from "../time.ts";
import type { ServicePlan } from "./types.ts";

export type FrequencyWindow = "now" | "day";

const HOUR = 3600;
const DAY = 24 * HOUR;
/**
 * The day average (hours from the shown service day's start): 06:00 to 21:00, the hours most riders
 * travel; later hours are a time on the slider away with "now". Trips are counted by when they run,
 * whichever service day they belong to.
 */
export const DAY_WINDOW = { fromH: 6, toH: 21 } as const;

export class BusFrequency {
  private readonly plan: ServicePlan;
  private readonly services: (date: ServiceDate) => Set<string>;
  /** Per pattern: its trips' indices in plan.trips. */
  private readonly tripsOf: number[][];
  private readonly starts = new Map<ServiceDate, Float64Array[]>();

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.services = indexCalendar(plan.calendar);
    this.tripsOf = plan.patterns.map(() => []);
    plan.trips.forEach((t, i) => this.tripsOf[t.pattern]?.push(i));
  }

  /** Per pattern, the sorted start times of its trips on a date. */
  private startsOn(date: ServiceDate): Float64Array[] {
    let s = this.starts.get(date);
    if (s) return s;
    const active = this.services(date);
    s = this.tripsOf.map((ts) =>
      Float64Array.from(
        ts
          .filter((i) => active.has(this.plan.trips[i]!.service))
          .map((i) => this.plan.trips[i]!.start),
      ).sort(),
    );
    if (this.starts.size > 4) this.starts.clear();
    this.starts.set(date, s);
    return s;
  }

  /**
   * Trips an hour per pattern, starting in the window. The window is looked up in the shown
   * service day and its neighbours: the previous day's trips can start after midnight (times past
   * 24:00), and the next day's before its 06:00.
   */
  perHour(date: ServiceDate, window: FrequencyWindow, t: number): Float64Array {
    const [from, to] =
      window === "now" ?
        [t, t + HOUR]
      : [DAY_WINDOW.fromH * HOUR, DAY_WINDOW.toH * HOUR];
    const hours = (to - from) / HOUR;
    const out = new Float64Array(this.plan.patterns.length);
    for (const k of [-1, 0, 1]) {
      const starts = this.startsOn(addDays(date, k));
      starts.forEach((a, p) => {
        if (a.length)
          out[p]! += countIn(a, from - k * DAY, to - k * DAY) / hours;
      });
    }
    return out;
  }
}

/** How many of the sorted values are in [lo, hi). */
function countIn(a: Float64Array, lo: number, hi: number): number {
  return lowerBound(a, hi) - lowerBound(a, lo);
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
