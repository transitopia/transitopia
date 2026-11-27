// Shareable view state in the query string: ?date=2026-11-04T17:05:00-06&rate=10&paused=1&select=<key>
// (apps/web/README.md#modes-and-url-state). `date` is an instant: a full ISO 8601 time with its UTC
// offset as short as it can be ("Z" for UTC, minutes only when not zero: "+05:30"), written in the
// time bar's zone; the offset fixes the instant, while the time bar's zone still comes from the view
// (packages/transit-map/README.md#time-zones). `select` names a station, exchange, stop, route,
// combined route or vehicle by a feature key (packages/shared/src/features.ts, src/select.ts): an ID
// or a ref. No time means "live". The map position lives in the hash (MapLibre's hash option).

import { toWallTime, tzOffsetMs } from "@transitopia/transit-core/time.ts";
import { parseKey } from "@transitopia/shared/features.ts";
import { formatQuery } from "@transitopia/shared/url.ts";
import type { Clock } from "./clock.ts";

/** A tapped station, bus exchange, bus stop or route line (its card), or a combined route. */
export interface Place {
  kind: "station" | "exchange" | "stop" | "route" | "shared";
  /** The feed it's in: its id is that feed's (packages/transit-map/README.md#feeds). */
  feed: string;
  /**
   * Station (parent stop_id), exchange id (BusHub), GTFS stop_id, route key, or a combined route's
   * ends (`sharedPlace`).
   */
  id: string;
}

/**
 * A feed's combined route between two stops or stations (stop keys: a station's id or a stop's,
 * packages/transit-core/DESIGN.md#combined-routes).
 */
export function sharedPlace(feed: string, from: string, to: string): Place {
  return { kind: "shared", feed, id: `${from}>${to}` };
}

/** A combined route's ends (`sharedPlace`). */
export function sharedEnds(place: Place): { from: string; to: string } {
  const i = place.id.indexOf(">");
  return { from: place.id.slice(0, i), to: place.id.slice(i + 1) };
}

export interface UrlState {
  t?: number;
  rate?: number;
  paused?: boolean;
  /** A feature key (an ID or a ref); invalid ones are dropped. */
  select?: string;
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

/** An ISO 8601 time with a UTC offset ("2026-11-04T17:05:00-06", "…T00:05Z") as epoch ms, or undefined. */
export function parseInstant(s: string): number | undefined {
  const m = ISO_INSTANT.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59)
    return undefined;
  const offsetMin =
    m[7] ?
      (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9] ?? 0))
    : 0;
  return Date.UTC(y, mo - 1, d, h, mi, sec) - offsetMin * 60_000;
}

/** An instant as local time in `tz` with its offset, as short as it can be: "2026-11-04T17:05:00-06". */
export function formatInstant(t: number, tz: string): string {
  const w = toWallTime(t, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  const offsetMin = Math.round(tzOffsetMs(t, tz) / 60_000);
  const abs = Math.abs(offsetMin);
  const offset =
    offsetMin === 0 ? "Z" : (
      `${offsetMin < 0 ? "-" : "+"}${p(Math.floor(abs / 60))}${abs % 60 ? `:${p(abs % 60)}` : ""}`
    );
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}${offset}`;
}

/** The URL's state. */
export function readUrl(): UrlState {
  const q = new URLSearchParams(location.search);
  const out: UrlState = {};
  const t = parseInstant(q.get("date") ?? "");
  if (t !== undefined) out.t = t;
  const rate = Number(q.get("rate"));
  if (q.has("rate") && Number.isFinite(rate) && rate !== 0) out.rate = rate;
  if (q.get("paused") === "1") out.paused = true;
  const select = q.get("select");
  if (select && parseKey(select)) out.select = select;
  return out;
}

export function writeUrl(
  clock: Clock,
  select: string | undefined,
  tz: string,
): void {
  const q = new URLSearchParams();
  if (!clock.isLive()) {
    q.set("date", formatInstant(Math.floor(clock.now() / 1000) * 1000, tz));
    if (clock.rate !== 1) q.set("rate", String(clock.rate));
    if (!clock.playing) q.set("paused", "1");
  }
  if (select) q.set("select", select);
  const search = formatQuery(q);
  const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`)
    history.replaceState(null, "", url);
}
