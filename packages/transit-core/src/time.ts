// Time helpers. Service dates are 'YYYYMMDD' strings (GTFS convention); instants are epoch milliseconds.
// Scheduled times are seconds since the service day's GTFS reference point ("noon minus 12h" local time),
// which differs from local midnight on DST transition days.

export const TIMEZONE = "America/Vancouver";
export const DAY_S = 86_400;

/** Parse a GTFS time ("5:05:00", " 25:30:00") into seconds. Returns NaN for blank values. */
export function parseGtfsTime(value: string): number {
  const v = value.trim();
  if (v === "") return NaN;
  const parts = v.split(":");
  if (parts.length !== 3)
    throw new Error(`Bad GTFS time: ${JSON.stringify(value)}`);
  const [h, m, s] = parts.map(Number) as [number, number, number];
  if (![h, m, s].every(Number.isFinite))
    throw new Error(`Bad GTFS time: ${JSON.stringify(value)}`);
  return h * 3600 + m * 60 + s;
}

/** Format seconds-since-service-day-start as H:MM[:SS] (hours may exceed 24). */
export function formatServiceTime(sec: number, withSeconds = false): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const base = `${h}:${String(m).padStart(2, "0")}`;
  return withSeconds ? `${base}:${String(ss).padStart(2, "0")}` : base;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Local wall-clock time of an instant in the given time zone. */
export function toWallTime(epochMs: number, tz = TIMEZONE): WallTime {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset (ms) of the zone from UTC at the given instant: local = utc + offset. */
export function tzOffsetMs(epochMs: number, tz = TIMEZONE): number {
  const w = toWallTime(epochMs, tz);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Instant for a local wall-clock time (ambiguous times resolve to the earlier instant). */
export function fromWallTime(w: WallTime, tz = TIMEZONE): number {
  const naive = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  let guess = naive - tzOffsetMs(naive, tz);
  // Second pass handles the case where the offset differs at the guessed instant.
  guess = naive - tzOffsetMs(guess, tz);
  return guess;
}

export function parseServiceDate(date: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!/^\d{8}$/.test(date)) throw new Error(`Bad service date: ${date}`);
  return {
    year: +date.slice(0, 4),
    month: +date.slice(4, 6),
    day: +date.slice(6, 8),
  };
}

export function formatServiceDate(
  year: number,
  month: number,
  day: number,
): string {
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/** Epoch ms of the GTFS reference point for a service date: local noon minus 12 hours. */
export function serviceDayStart(date: string, tz = TIMEZONE): number {
  const { year, month, day } = parseServiceDate(date);
  return (
    fromWallTime({ year, month, day, hour: 12, minute: 0, second: 0 }, tz)
    - 12 * 3600_000
  );
}

/** Calendar date arithmetic on service date strings. */
export function addDays(date: string, n: number): string {
  const { year, month, day } = parseServiceDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return formatServiceDate(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
  );
}

/** 0 = Monday … 6 = Sunday (matches calendar.txt column order). */
export function dayOfWeek(date: string): number {
  const { year, month, day } = parseServiceDate(date);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** Local calendar date of an instant. */
export function localDate(epochMs: number, tz = TIMEZONE): string {
  const w = toWallTime(epochMs, tz);
  return formatServiceDate(w.year, w.month, w.day);
}

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
