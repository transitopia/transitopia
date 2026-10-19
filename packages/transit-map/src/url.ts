// Shareable view state in the query string: ?date=2026-09-28&t=08:15:00&rate=10&paused=1&select=<key>
// (apps/web/README.md#modes-and-url-state). `select` names a station, exchange, stop, route or
// vehicle by a feature key (packages/shared/src/features.ts, src/select.ts): an ID or a ref.
// No time parameters means "live". The map position lives in the hash (MapLibre's hash option).
// `t` is service-day time, so it may exceed 24:00 for after-midnight trips.

import {
  formatServiceDate,
  formatServiceTime,
  parseGtfsTime,
  serviceDayStart,
} from "@transitopia/transit-core/time.ts";
import { parseKey } from "@transitopia/shared/features.ts";
import { displayServiceDate } from "./plans.ts";
import type { Clock } from "./clock.ts";

/** A tapped station, bus exchange, bus stop or route line (its card). */
export interface Place {
  kind: "station" | "exchange" | "stop" | "route";
  /** Station (parent stop_id), exchange id (BusHub), GTFS stop_id, or route key. */
  id: string;
}

export interface UrlState {
  t?: number;
  rate?: number;
  paused?: boolean;
  /** A feature key (an ID or a ref); invalid ones are dropped. */
  select?: string;
  /** Dispatch versions to preview, service date (YYYYMMDD) → version (?preview=20260927:15egjb9,…). */
  preview?: Record<string, string>;
}

export function readUrl(): UrlState {
  const q = new URLSearchParams(location.search);
  const out: UrlState = {};
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.get("date") ?? "");
  const time = q.get("t");
  if (date) {
    const d = formatServiceDate(+date[1]!, +date[2]!, +date[3]!);
    let sec = 8 * 3600;
    try {
      if (time) sec = parseGtfsTime(time.length === 5 ? `${time}:00` : time);
    } catch {
      // Keep the default time for malformed input.
    }
    if (Number.isFinite(sec)) out.t = serviceDayStart(d) + sec * 1000;
  }
  const rate = Number(q.get("rate"));
  if (q.has("rate") && Number.isFinite(rate) && rate !== 0) out.rate = rate;
  if (q.get("paused") === "1") out.paused = true;
  const select = q.get("select");
  if (select && parseKey(select)) out.select = select;
  const preview = Object.fromEntries(
    (q.get("preview") ?? "")
      .split(",")
      .map((p) => /^(\d{8}):([0-9a-z]+)$/.exec(p))
      .filter((m) => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
  if (Object.keys(preview).length) out.preview = preview;
  return out;
}

export function writeUrl(clock: Clock, select: string | undefined): void {
  const q = new URLSearchParams();
  if (!clock.isLive()) {
    const t = clock.now();
    const d = displayServiceDate(t);
    q.set("date", `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    q.set("t", formatServiceTime((t - serviceDayStart(d)) / 1000, true));
    if (clock.rate !== 1) q.set("rate", String(clock.rate));
    if (!clock.playing) q.set("paused", "1");
  }
  if (select) q.set("select", select);
  const kept = new URLSearchParams(location.search);
  for (const k of ["scenario", "preview"]) {
    const v = kept.get(k);
    if (v) q.set(k, v);
  }
  const search = formatQuery(q);
  const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`)
    history.replaceState(null, "", url);
}

/**
 * A query string that keeps ":" and "/" as they are: both are allowed in a query (RFC 3986), and
 * feature keys and times are full of colons (`select=run:25:3:2200325`, `t=08:15:00`), which
 * `URLSearchParams.toString()` would write as `%3A`. Everything else is escaped as usual, and
 * `URLSearchParams` reads the result back unchanged.
 */
export function formatQuery(q: URLSearchParams): string {
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  return [...q].map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}
