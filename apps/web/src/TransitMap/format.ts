import {
  localDate,
  toWallTime,
  tzOffsetMs,
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

/** Wall-clock time in a time zone (the snapshot's), "HH:MM:SS". */
export function clockTime(t: number, tz: string): string {
  const w = toWallTime(t, tz);
  return `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** A UTC offset in minutes as "UTC−7", "UTC+5:30", "UTC". */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const m = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(m / 60)}${m % 60 ? `:${pad(m % 60)}` : ""}`;
}

/**
 * A zone's short name at t, for display only (zones are compared by offset, never by name): the
 * runtime's generic abbreviation where it's one ("PT", "MT", "MST"), else its UTC offset.
 */
export function zoneLabel(t: number, tz: string): string {
  const name = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    timeZoneName: "shortGeneric",
  })
    .formatToParts(t)
    .find((p) => p.type === "timeZoneName")?.value;
  return name && /^[A-Z]{2,4}$/.test(name) ?
      name
    : offsetLabel(Math.round(tzOffsetMs(t, tz) / 60_000));
}

/**
 * The zone a card shows clock times in, and the mark they carry when its UTC offset at t isn't the
 * time bar's (" MST"; "" when it is). Relative times ("in 4 min") need no mark.
 */
export interface CardClock {
  tz: string;
  mark: string;
}

export function cardClock(t: number, tz: string, barTz: string): CardClock {
  return {
    tz,
    mark:
      tzOffsetMs(t, tz) === tzOffsetMs(t, barTz) ? "" : ` ${zoneLabel(t, tz)}`,
  };
}

/** A clock time "HH:MM" in a card's zone, with its mark. */
export function cardMinutes(t: number, clock: CardClock): string {
  return `${clockMinutes(t, clock.tz)}${clock.mark}`;
}

/** How far a zone's clock is from the device's at t ("+1 h", "−30 min"), or undefined when they agree. */
export function offsetFromDevice(t: number, tz: string): string | undefined {
  const minutes =
    Math.round(tzOffsetMs(t, tz) / 60_000) + new Date(t).getTimezoneOffset();
  if (minutes === 0) return undefined;
  const m = Math.abs(minutes);
  const sign = minutes < 0 ? "−" : "+";
  return m % 60 ?
      `${sign}${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ""}${m % 60} min`
    : `${sign}${m / 60} h`;
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

/** Wall-clock time in a time zone (the snapshot's), "HH:MM". */
export function clockMinutes(t: number, tz: string): string {
  return clockTime(t, tz).slice(0, 5);
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

export function timeState(snap: {
  t: number;
  live: boolean;
  timezone: string;
}): TimeState {
  return {
    live: snap.live,
    future: !snap.live && snap.t > Date.now(),
    // The calendar date (after midnight the service day is still the previous one).
    when: `${shortDate(localDate(snap.t, snap.timezone))}, ${clockMinutes(snap.t, snap.timezone)}`,
  };
}
