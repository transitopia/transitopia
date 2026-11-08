// Carry real-time bus delays forward into schedule estimates (packages/transit-core/DESIGN.md#buses).
//
// Each bus's latest fix gives its delay against the (profile-paced) schedule. The rest of that trip
// runs shifted by that delay, and lateness carries into the bus's next trips, less the layover slack
// beyond a minimum turnaround. Early running doesn't carry past the terminus: buses wait for their
// departure time. Used where RT prediction stops (a bus unreported for a while, or fast-forwarding
// past the live edge), so estimates continue from where the bus really was instead of jumping to the
// timetable. A cancelled trip (GTFS-RT) isn't run, so nothing carries into or past it.

import type {
  PreparedPlan,
  PreparedTrip,
  ScheduleCorrections,
} from "../schedule/engine.ts";
import { toWallTime, type ServiceDate } from "../time.ts";

export interface TripDelay {
  tripId: string;
  serviceDate: ServiceDate;
  /** Seconds late (+) or early (−) at the fix. */
  delay: number;
  /** Scheduled service-day second at the fix's position. */
  schedSec: number;
  /** Epoch ms of the fix. */
  fixTs: number;
  /** The bus that reported it. */
  vehicle: CarriedBus;
  /**
   * The same bus's next fix, when known (recorded playback: after t): its trip, delay there and the
   * scheduled second it was measured at.
   */
  next?:
    | {
        tripId: string;
        serviceDate: ServiceDate;
        delay: number;
        schedSec: number;
        fixTs: number;
      }
    | undefined;
}

/** The bus a carried estimate stands for, so it keeps the RT vehicle's id and number. */
export interface CarriedBus {
  /** The RT vehicle's id (`rt:<id>`). */
  id: string;
  /** Its fleet number. */
  label?: string | undefined;
}

export interface CarryConfig {
  /** Minimum turnaround at a terminus; layover beyond this absorbs lateness (s). */
  minLayoverS: number;
  /** Carry into at most this many following trips. */
  maxTrips: number;
}

const hhmm = (ms: number, tz: string) => {
  const w = toWallTime(ms, tz);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
};

const delayLabel = (delay: number, ts: number, tz: string) => {
  const mins = Math.round(delay / 60);
  return `GTFS-RT delay (${mins === 0 ? "on time" : `${mins > 0 ? "+" : ""}${mins} min`} at ${hhmm(ts, tz)})`;
};

/**
 * Schedule corrections per service date from RT delays; `carried` = every trip they affect, and the
 * bus running it. Where a delay knows the bus's next fix (recorded playback), the estimate meets
 * it: its trip is anchored there too, so a bus that leaves late waits at its first stop rather than
 * leaving on time and jumping back. `ran` (recorded playback: whether any fix reports a trip) stops
 * carrying into a trip the recording never shows, when the bus has no next fix: it didn't run, at
 * least not with a bus that reported it.
 */
export function delayCorrections(
  pp: PreparedPlan,
  delays: TripDelay[],
  cfg: CarryConfig,
  cancelled?: (serviceDate: ServiceDate, tripId: string) => boolean,
  ran?: (tripId: string) => boolean,
): {
  byDate: Map<ServiceDate, ScheduleCorrections>;
  carried: Map<string, CarriedBus>;
} {
  const byDate = new Map<ServiceDate, ScheduleCorrections>();
  const carried = new Map<string, CarriedBus>();
  const observed = new Set(delays.map((d) => d.tripId));
  const tz = pp.plan.timezone;
  for (const d of delays) {
    const first = pp.tripIndex.get(d.tripId);
    if (!first || cancelled?.(d.serviceDate, d.tripId)) continue;
    let trip: PreparedTrip = first;
    let corr = byDate.get(d.serviceDate);
    if (!corr)
      byDate.set(
        d.serviceDate,
        (corr = {
          trips: new Map(),
          cancelled: new Set(),
          consists: new Map(),
        }),
      );
    const label = delayLabel(d.delay, d.fixTs, tz);
    // The bus's next fix, on the same service date.
    const n = d.next?.serviceDate === d.serviceDate ? d.next : undefined;
    const nLabel = n && delayLabel(n.delay, n.fixTs, tz);
    const anchors = [{ sched: d.schedSec, shift: d.delay }];
    let estimate = label;
    if (n?.tripId === d.tripId) {
      if (n.schedSec > d.schedSec + 1)
        anchors.push({ sched: n.schedSec, shift: n.delay });
      // Still at the same scheduled point later on (waiting to leave): the later fix knows better.
      else if (n.delay > d.delay)
        anchors[0] = { sched: d.schedSec, shift: n.delay };
      if (anchors.length > 1 || n.delay > d.delay)
        estimate = `${label}, then ${nLabel}`;
    }
    corr.trips.set(d.tripId, { anchors, observed: [], estimate });
    carried.set(d.tripId, d.vehicle);
    // At its next fix it's still on this trip: no later trip runs before then.
    if (n?.tripId === d.tripId) continue;
    // Its next fix is on one of the trips this bus runs next: carry up to it.
    let toNext = false;
    for (let k = 0, x = trip.next; n && k < cfg.maxTrips && x; k++, x = x.next)
      if (x.trip.id === n.tripId) toNext = true;
    let late = d.delay;
    for (let k = 0; k < cfg.maxTrips && trip.next; k++) {
      const next: PreparedTrip = trip.next;
      if (cancelled?.(d.serviceDate, next.trip.id)) break;
      if (n?.tripId === next.trip.id) {
        if (!observed.has(next.trip.id)) {
          corr.trips.set(next.trip.id, {
            anchors: [{ sched: n.schedSec, shift: n.delay }],
            observed: [],
            estimate: nLabel!,
          });
          carried.set(next.trip.id, d.vehicle);
        }
        break;
      }
      // Its next fix is on some other trip: it didn't run these.
      if (n && !toNext) break;
      if (!n && ran && !ran(next.trip.id)) break;
      const slack =
        next.trip.start - trip.arr[trip.arr.length - 1]! - cfg.minLayoverS;
      late -= Math.max(0, slack);
      if (late <= 0 && !toNext) break;
      // A later trip's own fix (if any) takes precedence; it's added when its delay is processed.
      if (!observed.has(next.trip.id)) {
        corr.trips.set(next.trip.id, {
          anchors: [{ sched: next.trip.start, shift: Math.max(0, late) }],
          observed: [],
          estimate: `${label}, carried over layover`,
        });
        carried.set(next.trip.id, d.vehicle);
      }
      trip = next;
    }
  }
  return { byDate, carried };
}
