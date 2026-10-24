import {
  localDate,
  toWallTime,
  isServiceDate,
  type ServiceDate,
} from "@transitopia/transit-core/time.ts";

/** "20260929" → "2026-09-29" (the date input's format). */
export function isoDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** "2026-09-29" → "20260929", or undefined if malformed. */
export function fromIsoDate(s: string): ServiceDate | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && `${m[1]}${m[2]}${m[3]}`;
  return d && isServiceDate(d) ? d : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock time in the region's timezone, "HH:MM:SS". */
export function clockTime(t: number): string {
  const w = toWallTime(t);
  return `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

export function rateLabel(r: number): string {
  return `${r < 0 ? "−" : ""}${Math.abs(r)}×`;
}

/** "20261006" → "Tue 6 Oct". */
export function shortDate(d: string): string {
  return new Date(
    Date.UTC(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
    ),
  ).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "To King George" from GTFS headsigns like "Expo Line To King George". */
export function toHeadsign(h: string): string {
  return h.replace(/^.*?\bTo\s+/i, "To ");
}

/** Wall-clock time in the region's timezone, "HH:MM". */
export function clockMinutes(t: number): string {
  return clockTime(t).slice(0, 5);
}

/**
 * How the map's time stands against now (apps/web/README.md#time-and-not-live): live, or not
 * live showing the past (recorded or replayed) or the future (projected from the timetable).
 */
export interface TimeState {
  live: boolean;
  future: boolean;
  /** "Tue 6 Oct, 08:00". */
  when: string;
}

export function timeState(snap: { t: number; live: boolean }): TimeState {
  return {
    live: snap.live,
    future: !snap.live && snap.t > Date.now(),
    // The calendar date (after midnight the service day is still the previous one).
    when: `${shortDate(localDate(snap.t))}, ${clockMinutes(snap.t)}`,
  };
}
