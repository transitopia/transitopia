// Service changes TransLink publishes in GTFS-RT for our bus routes and train lines, collected per service date by
// the RT service (apps/server/src/rt/changes.ts) and served at /feeds/<feed>/days/<YYYYMMDD>/changes (versioned, the feed's live endpoint points to the current version):
//  - cancelled trips (TripUpdates schedule_relationship CANCELED). The feed drops a trip once its
//    time has passed, so only a recording keeps them for replaying the day. Seen 2026-09-29: some
//    list only their remaining stops as skipped (cancelled part-way, "resuming at Lonsdale Quay");
//    the whole trip is treated as cancelled, and a bus still reporting it is shown from its fixes;
//  - stops skipped by running trips (stop_time_update SKIPPED), e.g. an R2 detouring around
//    Kootenay Loop;
//  - "no service" alerts naming a trip: TransLink announces cancellations this way too, and the
//    alerts outlive the trip updates (a trip cancelled before recording started is only known from
//    its alert). Those listing stops ("resuming service at Lonsdale Quay") skip just those stops;
//  - DETOUR alerts. They name the route (and direction or trip) and the affected stops; the detour
//    path is only in the text ("via Gilmore Ave, Lougheed Hwy, ..."), so it isn't drawn;
//  - train line alerts (SkyTrain and West Coast Express: track work, single-tracking, delays,
//    elevators): there are no train trip updates, so these are shown as text only, while they apply (ChangesView.alerts): those that
//    change how a line runs (`isServiceAlert`) on the time bar and line cards, any naming a
//    station's platforms on its card (packages/transit-core/DESIGN.md#train-alerts).
// See config/feeds/translink/OPEN-QUESTIONS.md #28.

import type { ServiceDate } from "../time.ts";

/** GTFS-RT Alert.Effect values. */
export const EFFECT_NO_SERVICE = 1;
export const EFFECT_REDUCED_SERVICE = 2;
export const EFFECT_SIGNIFICANT_DELAYS = 3;
export const EFFECT_DETOUR = 4;
export const EFFECT_MODIFIED_SERVICE = 6;

/**
 * Effects that change how a line runs. TransLink's other train line alerts are mostly elevator and
 * escalator outages (ACCESSIBILITY_ISSUE), fare notices (NO_EFFECT) and entrance closures
 * (UNKNOWN_EFFECT): about a station, not the line (seen 2026-11-27: 4 of 19 were service changes).
 */
const SERVICE_EFFECTS: ReadonlySet<number> = new Set([
  EFFECT_NO_SERVICE,
  EFFECT_REDUCED_SERVICE,
  EFFECT_SIGNIFICANT_DELAYS,
  EFFECT_MODIFIED_SERVICE,
]);

/** Whether an alert changes how its routes run, rather than being about a station or fares. */
export function isServiceAlert(a: RtRouteAlert): boolean {
  return a.effect !== undefined && SERVICE_EFFECTS.has(a.effect);
}

export interface RtRouteAlert {
  id: string;
  /** Which of our routes it's about, optionally narrowed to a direction or a trip. */
  entities: { routeKey: string; directionId?: number; tripId?: string }[];
  stopIds: string[];
  effect?: number;
  /** Epoch ms; an open end is undefined. */
  periods: { start?: number; end?: number }[];
  header: string;
  description: string;
  /** Epoch ms of the first and last poll that included it (alerts are often removed before their end). */
  seen: [number, number];
}

export interface RtDayChanges {
  /** Service date, YYYYMMDD. */
  date: ServiceDate;
  /** trip_id → [first, last] epoch ms it was seen cancelled. */
  cancelled: Record<string, [number, number]>;
  /** trip_id → stop_ids seen skipped (not for cancelled trips). */
  skipped: Record<string, string[]>;
  /** Alerts for our bus routes and train lines seen during this (local calendar) day; trips they name run on it. */
  alerts: RtRouteAlert[];
}

export function emptyDayChanges(date: ServiceDate): RtDayChanges {
  return { date, cancelled: {}, skipped: {}, alerts: [] };
}

/**
 * Whether an alert applies at t: within an active period, and until it was withdrawn (last seen, plus
 * `graceMs`, the alerts poll interval, since a removal is only seen at the next poll). Without a
 * period start it applies from when it was first seen.
 */
export function alertActiveAt(
  a: RtRouteAlert,
  t: number,
  graceMs: number,
): boolean {
  if (t > a.seen[1] + graceMs) return false;
  const from = (start: number | undefined) => start ?? a.seen[0] - graceMs;
  if (!a.periods.length) return t >= from(undefined);
  return a.periods.some(
    (p) => t >= from(p.start) && (p.end === undefined || t <= p.end),
  );
}

/**
 * The active period an alert is in at t (epoch ms, an open end undefined), for saying when it
 * applies; without periods, open at both ends.
 */
export function alertPeriodAt(
  a: RtRouteAlert,
  t: number,
): { start?: number | undefined; end?: number | undefined } {
  return (
    a.periods.find(
      (p) =>
        (p.start === undefined || t >= p.start)
        && (p.end === undefined || t <= p.end),
    )
    // Applying from when it was first seen, before its period's start.
    ?? a.periods[0]
    ?? {}
  );
}

/** Detour alerts covering a bus on a trip at t. */
export function detoursFor(
  alerts: RtRouteAlert[],
  routeKey: string,
  directionId: number | undefined,
  tripId: string | undefined,
  t: number,
  graceMs: number,
): RtRouteAlert[] {
  return alerts.filter(
    (a) =>
      a.effect === EFFECT_DETOUR
      && a.entities.some(
        (e) =>
          e.routeKey === routeKey
          && (e.directionId === undefined || e.directionId === directionId)
          && (e.tripId === undefined || e.tripId === tripId),
      )
      && alertActiveAt(a, t, graceMs),
  );
}

/** Merges alerts from several days' files (an alert running over midnight is in both). */
export function mergeAlerts(
  days: (RtDayChanges | undefined)[],
): RtRouteAlert[] {
  const byId = new Map<string, RtRouteAlert>();
  for (const d of days) {
    for (const a of d?.alerts ?? []) {
      const b = byId.get(a.id);
      byId.set(
        a.id,
        b ?
          {
            ...a,
            seen: [
              Math.min(a.seen[0], b.seen[0]),
              Math.max(a.seen[1], b.seen[1]),
            ],
          }
        : a,
      );
    }
  }
  return [...byId.values()];
}

/** Lookups over the loaded days' changes, for the timeline, the predictor and carried delays. */
export interface ChangesView {
  cancelled: (serviceDate: ServiceDate, tripId: string) => boolean;
  /** Every trip cancelled on a service date. */
  cancelledTrips: (serviceDate: ServiceDate) => string[];
  skipped: (
    serviceDate: ServiceDate,
    tripId: string,
  ) => ReadonlySet<string> | undefined;
  /** Detour alerts covering a bus on its trip at t. */
  detours: (
    routeKey: string,
    directionId: number | undefined,
    tripId: string | undefined,
    t: number,
  ) => RtRouteAlert[];
  /**
   * Alerts about any of these routes that apply at t, the first of any with the same text (TransLink
   * sometimes publishes one notice under several ids).
   */
  alerts: (routeKeys: ReadonlySet<string>, t: number) => RtRouteAlert[];
}

/** @param graceMs how long an alert still counts after it was last seen (its poll interval), fixed or at a time. */
export function changesView(
  days: RtDayChanges[],
  graceMs: number | ((t: number) => number),
): ChangesView {
  const cancelled = new Set<string>();
  const skipped = new Map<string, Set<string>>();
  const skip = (key: string, stops: string[]) => {
    let s = skipped.get(key);
    if (!s) skipped.set(key, (s = new Set()));
    for (const id of stops) s.add(id);
  };
  for (const d of days) {
    for (const trip of Object.keys(d.cancelled))
      cancelled.add(`${d.date}|${trip}`);
    for (const [trip, stops] of Object.entries(d.skipped))
      skip(`${d.date}|${trip}`, stops);
    for (const a of d.alerts) {
      if (a.effect !== EFFECT_NO_SERVICE) continue;
      for (const e of a.entities) {
        if (!e.tripId) continue;
        if (a.stopIds.length) skip(`${d.date}|${e.tripId}`, a.stopIds);
        else cancelled.add(`${d.date}|${e.tripId}`);
      }
    }
  }
  const merged = mergeAlerts(days);
  const alerts = merged.filter((a) => a.effect === EFFECT_DETOUR);
  const grace = (t: number) =>
    typeof graceMs === "number" ? graceMs : graceMs(t);
  return {
    cancelledTrips: (date) =>
      [...cancelled]
        .filter((k) => k.startsWith(`${date}|`))
        .map((k) => k.slice(date.length + 1)),
    cancelled: (date, tripId) => cancelled.has(`${date}|${tripId}`),
    skipped: (date, tripId) => skipped.get(`${date}|${tripId}`),
    detours: (routeKey, directionId, tripId, t) =>
      alerts.length ?
        detoursFor(alerts, routeKey, directionId, tripId, t, grace(t))
      : [],
    alerts: (routeKeys, t) => {
      const texts = new Set<string>();
      return merged.filter((a) => {
        if (
          !a.entities.some((e) => routeKeys.has(e.routeKey))
          || !alertActiveAt(a, t, grace(t))
        )
          return false;
        const text = `${a.header}\n${a.description}`;
        if (texts.has(text)) return false;
        texts.add(text);
        return true;
      });
    },
  };
}
