import { toWallTime } from "@transitopia/transit-core/time.ts";

/** "20260929" → "2026-09-29" (the date input's format). */
export function isoDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** "2026-09-29" → "20260929", or undefined if malformed. */
export function fromIsoDate(s: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[1]}${m[2]}${m[3]}` : undefined;
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
