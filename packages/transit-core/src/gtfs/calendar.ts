import { dayOfWeek } from "../time.ts";

/** A calendar.txt row. days[0] = Monday … days[6] = Sunday. */
export interface CalendarEntry {
  serviceId: string;
  days: boolean[];
  start: string; // YYYYMMDD inclusive
  end: string; // YYYYMMDD inclusive
}

/** calendar_dates.txt: 1 = service added on that date, 2 = removed. */
export interface CalendarException {
  serviceId: string;
  date: string;
  type: 1 | 2;
}

export interface ServiceCalendar {
  calendar: CalendarEntry[];
  exceptions: CalendarException[];
}

/** Service IDs running on a service date, applying calendar ranges and calendar_dates exceptions. */
export function activeServices(
  cal: ServiceCalendar,
  date: string,
): Set<string> {
  const active = new Set<string>();
  const dow = dayOfWeek(date);
  for (const c of cal.calendar) {
    if (date >= c.start && date <= c.end && c.days[dow])
      active.add(c.serviceId);
  }
  for (const e of cal.exceptions) {
    if (e.date !== date) continue;
    if (e.type === 1) active.add(e.serviceId);
    else active.delete(e.serviceId);
  }
  return active;
}

/** Index exceptions by date for repeated lookups. */
export function indexCalendar(
  cal: ServiceCalendar,
): (date: string) => Set<string> {
  const byDate = new Map<string, CalendarException[]>();
  for (const e of cal.exceptions) {
    let list = byDate.get(e.date);
    if (!list) byDate.set(e.date, (list = []));
    list.push(e);
  }
  return (date) =>
    activeServices(
      { calendar: cal.calendar, exceptions: byDate.get(date) ?? [] },
      date,
    );
}
