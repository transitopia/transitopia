// Human description of a service day, e.g. "Monday", "Holiday: Sunday service". Derived from the
// data, not hardcoded: a date is "regular" if its active service set is the most common one for
// that weekday in the weeks around it (NEAR_WEEKS), so a feed covering two timetable periods (fall
// and winter service) has regular days in both.

import {
  addDays,
  dayOfWeek,
  WEEKDAY_NAMES,
  type ServiceDate,
} from "../time.ts";

export interface ServiceDayInfo {
  label: string;
  regular: boolean;
}

/**
 * Weeks either side of a date whose same weekday says what's usual for it: a holiday or a week's
 * break is outvoted, and a timetable period of 4 weeks or more is usual within itself.
 */
const NEAR_WEEKS = 3;

function key(services: Set<string>): string {
  return [...services].sort().join(",");
}

export function makeServiceDescriber(
  servicesOn: (date: ServiceDate) => Set<string>,
  feedStart: ServiceDate,
  feedEnd: ServiceDate,
): (date: ServiceDate) => ServiceDayInfo {
  const keys = new Map<ServiceDate, string>();
  const keyOn = (d: ServiceDate) => {
    let k = keys.get(d);
    if (k === undefined) keys.set(d, (k = key(servicesOn(d))));
    return k;
  };
  /** Whether `k` is the most common set (or one of them) on `around`'s weekday within NEAR_WEEKS of it. */
  const usual = (k: string, around: ServiceDate) => {
    const counts = new Map<string, number>();
    for (let w = -NEAR_WEEKS; w <= NEAR_WEEKS; w++) {
      const d = addDays(around, w * 7);
      if (d < feedStart || d > feedEnd) continue;
      const c = keyOn(d);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const n = counts.get(k) ?? 0;
    return n > 0 && [...counts.values()].every((c) => c <= n);
  };

  return (date) => {
    const dow = dayOfWeek(date);
    const name = WEEKDAY_NAMES[dow]!;
    const services = servicesOn(date);
    if (services.size === 0)
      return { label: `${name}: no service in this timetable`, regular: false };
    const k = key(services);
    if (usual(k, date)) return { label: name, regular: true };
    // The same week's Sunday and Saturday.
    if (dow < 5 && usual(k, addDays(date, 6 - dow)))
      return { label: `${name}: holiday (Sunday service)`, regular: false };
    if (dow < 5 && usual(k, addDays(date, 5 - dow)))
      return { label: `${name}: Saturday service`, regular: false };
    return { label: `${name}: special service`, regular: false };
  };
}
