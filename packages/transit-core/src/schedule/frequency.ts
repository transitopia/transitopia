// How often a route runs, from the timetable, for the site's route card
// (packages/transit-core/DESIGN.md#departures): minutes between trips per hour of a service day,
// and the feed's day types (the distinct sets of services a date can have).

import { addDays } from "../time.ts";
import type { PreparedPlan } from "./engine.ts";

/** The route card's day strip: an hour cell from 05:00 to 01:00 (service hours, may exceed 24). */
export const DAY_HOURS: readonly number[] = Array.from(
  { length: 21 },
  (_, i) => 5 + i,
);

/**
 * Average minutes between a route's trips starting in the `seconds` from `from` (service seconds)
 * on a date: per hour over the trips in its busier direction (each direction is a passenger's
 * choice; a branching line's trips in one direction all serve its trunk). Undefined when nothing
 * runs. The window is a length, not an end, so the result doesn't pick up floating-point error
 * from a fractional `from` (it would flicker across rounding and band edges). Catalogue routes
 * (not drawn) count their trips' start times the same way.
 */
export function routeMinutes(
  pp: PreparedPlan,
  routeKey: string,
  date: string,
  from: number,
  seconds: number,
): number | undefined {
  const to = from + seconds;
  const cat = pp.catalog.get(routeKey);
  if (cat) {
    // A route not drawn: its trips' start times (minutes) from the catalogue.
    const perDir = [0, 0];
    for (const service of pp.servicesOn(date))
      cat.starts[service]?.forEach((list, d) => {
        for (const m of list) if (m * 60 >= from && m * 60 < to) perDir[d]!++;
      });
    const n = Math.max(...perDir);
    return n ? seconds / 60 / n : undefined;
  }
  const perDirection = new Map<number, number>();
  for (const service of pp.servicesOn(date)) {
    for (const pt of pp.tripsByService.get(service) ?? []) {
      if (pt.trip.start >= to) break; // sorted by start
      if (pt.trip.start < from || pt.route.key !== routeKey) continue;
      const d = pt.pattern.direction;
      perDirection.set(d, (perDirection.get(d) ?? 0) + 1);
    }
  }
  const n = Math.max(0, ...perDirection.values());
  return n ? seconds / 60 / n : undefined;
}

/** Minutes between trips for each hour of DAY_HOURS on a date. */
export function hourlyMinutes(
  pp: PreparedPlan,
  routeKey: string,
  date: string,
): (number | undefined)[] {
  return DAY_HOURS.map((h) => routeMinutes(pp, routeKey, date, h * 3600, 3600));
}

export interface DayType {
  /** A date with this set of services, the first found from the start date. */
  date: string;
  /** The services that run (sorted), which is what makes days alike. */
  services: string[];
}

/**
 * The feed's kinds of day, in the order they come from `from` (so the first is that day's): dates
 * alike when the same services run. Looks `days` ahead, within the feed's validity.
 */
export function dayTypes(pp: PreparedPlan, from: string, days = 14): DayType[] {
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
