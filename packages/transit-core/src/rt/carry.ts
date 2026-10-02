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
import { toWallTime } from "../time.ts";

export interface TripDelay {
  tripId: string;
  serviceDate: string;
  /** Seconds late (+) or early (−) at the fix. */
  delay: number;
  /** Scheduled service-day second at the fix's position. */
  schedSec: number;
  /** Epoch ms of the fix. */
  fixTs: number;
}

export interface CarryConfig {
  /** Minimum turnaround at a terminus; layover beyond this absorbs lateness (s). */
  minLayoverS: number;
  /** Carry into at most this many following trips. */
  maxTrips: number;
}

const hhmm = (ms: number) => {
  const w = toWallTime(ms);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
};

/** Schedule corrections per service date from RT delays; `carried` = every trip they affect. */
export function delayCorrections(
  pp: PreparedPlan,
  delays: TripDelay[],
  cfg: CarryConfig,
  cancelled?: (serviceDate: string, tripId: string) => boolean,
): { byDate: Map<string, ScheduleCorrections>; carried: Set<string> } {
  const byDate = new Map<string, ScheduleCorrections>();
  const carried = new Set<string>();
  const observed = new Set(delays.map((d) => d.tripId));
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
    const mins = Math.round(d.delay / 60);
    const label = `GTFS-RT delay (${mins === 0 ? "on time" : `${mins > 0 ? "+" : ""}${mins} min`} at ${hhmm(d.fixTs)})`;
    corr.trips.set(d.tripId, {
      anchors: [{ sched: d.schedSec, shift: d.delay }],
      observed: [],
      estimate: label,
    });
    carried.add(d.tripId);
    let late = d.delay;
    for (let k = 0; k < cfg.maxTrips && late > 0 && trip.next; k++) {
      const next: PreparedTrip = trip.next;
      if (cancelled?.(d.serviceDate, next.trip.id)) break;
      const slack =
        next.trip.start - trip.arr[trip.arr.length - 1]! - cfg.minLayoverS;
      late -= Math.max(0, slack);
      if (late <= 0) break;
      // A later trip's own fix (if any) takes precedence; it's added when its delay is processed.
      if (!observed.has(next.trip.id)) {
        corr.trips.set(next.trip.id, {
          anchors: [{ sched: next.trip.start, shift: late }],
          observed: [],
          estimate: `${label}, carried over layover`,
        });
        carried.add(next.trip.id);
      }
      trip = next;
    }
  }
  return { byDate, carried };
}
