// How often buses pass along each bus corridor and stop at each stop (packages/transit-core/DESIGN.md#bus-corridors):
// buses per hour in the busiest direction, for the hour around a time ("now"), or averaged over the
// day (06:00–24:00) or the night after it (00:00–06:00). Counts use each pattern's trips on the date
// and one representative trip's timing along the pattern, so a corridor's count is for when buses
// pass it, not when they leave their first stop.

import { indexCalendar } from "../gtfs/calendar.ts";
import { addDays, type ServiceDate } from "../time.ts";
import type { ServicePlan } from "./types.ts";

export type FrequencyWindow = "now" | "day" | "night";

/** Lower bounds of the frequency tiers (buses per hour): every 6 min, 15 min, 30 min, less often. */
export const FREQUENCY_TIERS = [10, 4, 2, 0] as const;

/** Tier of a frequency: 0 (every 6 min or better) to 3 (less often than every 30 min), or -1 for none. */
export function frequencyTier(perHour: number): number {
  if (!(perHour > 0)) return -1;
  return FREQUENCY_TIERS.findIndex((min) => perHour >= min);
}

const HOUR = 3600;
const DAY = 24 * HOUR;
/** The day average covers 06:00–24:00 and the night 00:00–06:00 (the night after the day shown). */
const DAY_FROM = 6 * HOUR;

/** A time window on one service date (seconds since its service day start). */
interface Span {
  date: ServiceDate;
  from: number;
  to: number;
}

export class BusFrequency {
  private readonly plan: ServicePlan;
  private readonly services: (date: ServiceDate) => Set<string>;
  /** Per pattern: its trips' indices in plan.trips. */
  private readonly tripsOf: number[][];
  /** Per pattern: a representative trip's arrival offsets from its start, per stop. */
  private readonly offsets: (number[] | undefined)[];
  private readonly starts = new Map<ServiceDate, Float64Array[]>();

  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.services = indexCalendar(plan.calendar);
    this.tripsOf = plan.patterns.map(() => []);
    plan.trips.forEach((t, i) => this.tripsOf[t.pattern]?.push(i));
    // The trip starting closest to midday: typical timing.
    this.offsets = this.tripsOf.map((ts) => {
      let best: number | undefined;
      for (const i of ts)
        if (
          best === undefined
          || Math.abs(plan.trips[i]!.start - 12 * HOUR)
            < Math.abs(plan.trips[best]!.start - 12 * HOUR)
        )
          best = i;
      return best === undefined ? undefined : plan.trips[best]!.arr;
    });
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

  /** Seconds from a pattern's start to the point `along` metres into it. */
  offsetAt(pattern: number, along: number): number {
    const arr = this.offsets[pattern];
    const dist = this.plan.patterns[pattern]?.dist;
    if (!arr || !dist?.length) return 0;
    if (along <= dist[0]!) return arr[0]!;
    for (let k = 1; k < dist.length; k++)
      if (along <= dist[k]!) {
        const f =
          dist[k]! > dist[k - 1]! ?
            (along - dist[k - 1]!) / (dist[k]! - dist[k - 1]!)
          : 0;
        return arr[k - 1]! + f * (arr[k]! - arr[k - 1]!);
      }
    return arr[arr.length - 1]!;
  }

  /** Stop offsets of a pattern (representative trip), or undefined without trips. */
  stopOffset(pattern: number, stopIndex: number): number {
    return this.offsets[pattern]?.[stopIndex] ?? 0;
  }

  private spans(
    date: ServiceDate,
    window: FrequencyWindow,
    t: number,
  ): { spans: Span[]; hours: number } {
    if (window === "day")
      return { spans: [{ date, from: DAY_FROM, to: DAY }], hours: 18 };
    if (window === "night")
      return {
        spans: [
          { date, from: DAY, to: DAY + DAY_FROM },
          { date: addDays(date, 1), from: 0, to: DAY_FROM },
        ],
        hours: 6,
      };
    // The hour around t, including trips of the previous service day still running after midnight.
    return {
      spans: [
        { date, from: t - HOUR / 2, to: t + HOUR / 2 },
        {
          date: addDays(date, -1),
          from: t + DAY - HOUR / 2,
          to: t + DAY + HOUR / 2,
        },
      ],
      hours: 1,
    };
  }

  /**
   * Buses per hour for each item: an item is a list of [pattern, offset (s), group], and its count
   * is the largest of its groups' sums (directions, for corridors).
   */
  count(
    items: readonly (readonly (readonly [number, number, number])[])[],
    date: ServiceDate,
    window: FrequencyWindow,
    t: number,
    include: (pattern: number) => boolean,
  ): Float32Array {
    const { spans, hours } = this.spans(date, window, t);
    const lists = spans.map((s) => ({ s, starts: this.startsOn(s.date) }));
    const out = new Float32Array(items.length);
    const sums = new Map<number, number>();
    items.forEach((refs, i) => {
      sums.clear();
      for (const [p, off, group] of refs) {
        if (!include(p)) continue;
        let n = 0;
        for (const { s, starts } of lists) {
          const a = starts[p];
          if (a?.length) n += countIn(a, s.from - off, s.to - off);
        }
        sums.set(group, (sums.get(group) ?? 0) + n);
      }
      let best = 0;
      for (const v of sums.values()) best = Math.max(best, v);
      out[i] = best / hours;
    });
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
