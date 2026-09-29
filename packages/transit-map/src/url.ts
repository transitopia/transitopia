// Shareable view state in the query string: ?date=2026-09-28&t=08:15:00&rate=10&paused=1&select=<vehicle>
// (V2-PLAN.md §1.3; `v` is the older name for `select`).
// No time parameters means "live". The map position lives in the hash (MapLibre's hash option).
// `t` is service-day time, so it may exceed 24:00 for after-midnight trips.

import {
  formatServiceDate,
  formatServiceTime,
  parseGtfsTime,
  serviceDayStart,
} from "@transitopia/transit-core/time.ts";
import { displayServiceDate } from "./plans.ts";
import type { Clock } from "./clock.ts";

export interface UrlState {
  t?: number;
  rate?: number;
  paused?: boolean;
  vehicle?: string;
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
  const v = q.get("select") ?? q.get("v");
  if (v) out.vehicle = v;
  return out;
}

export function writeUrl(clock: Clock, vehicle: string | undefined): void {
  const q = new URLSearchParams();
  if (!clock.isLive()) {
    const t = clock.now();
    const d = displayServiceDate(t);
    q.set("date", `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    q.set("t", formatServiceTime((t - serviceDayStart(d)) / 1000, true));
    if (clock.rate !== 1) q.set("rate", String(clock.rate));
    if (!clock.playing) q.set("paused", "1");
  }
  if (vehicle) q.set("select", vehicle);
  const scenario = new URLSearchParams(location.search).get("scenario");
  if (scenario) q.set("scenario", scenario);
  const search = q.toString();
  const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`)
    history.replaceState(null, "", url);
}
