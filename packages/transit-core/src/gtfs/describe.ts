// Human description of a service day, e.g. "Monday", "Holiday: Sunday service". Derived from the
// data, not hardcoded: a date is "regular" if its active service set is the most common one for
// that weekday across the feed's range.

import { addDays, dayOfWeek, WEEKDAY_NAMES } from "../time.ts";

export interface ServiceDayInfo {
  label: string;
  regular: boolean;
}

function key(services: Set<string>): string {
  return [...services].sort().join(",");
}

export function makeServiceDescriber(
  servicesOn: (date: string) => Set<string>,
  feedStart: string,
  feedEnd: string,
): (date: string) => ServiceDayInfo {
  // Most common service set for each weekday.
  const counts: Map<string, number>[] = Array.from(
    { length: 7 },
    () => new Map(),
  );
  for (let d = feedStart; d <= feedEnd; d = addDays(d, 1)) {
    const k = key(servicesOn(d));
    const m = counts[dayOfWeek(d)]!;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const typical = counts.map(
    (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
  );

  return (date) => {
    const dow = dayOfWeek(date);
    const name = WEEKDAY_NAMES[dow]!;
    const services = servicesOn(date);
    if (services.size === 0)
      return { label: `${name}: no service in this timetable`, regular: false };
    const k = key(services);
    if (k === typical[dow]) return { label: name, regular: true };
    if (dow < 5 && k === typical[6])
      return { label: `${name}: holiday (Sunday service)`, regular: false };
    if (dow < 5 && k === typical[5])
      return { label: `${name}: Saturday service`, regular: false };
    return { label: `${name}: special service`, regular: false };
  };
}
