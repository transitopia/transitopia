// Smoothing SeaBus corrections as new AIS fixes arrive (PLAN.md §4.12), like buses' glide
// (src/core/rt/timeline.ts). When a batch of fixes becomes known at time K, each vessel would jump
// from where it was drawn (`shown` corrections) to where the new corrections (`next`) put it.
// Instead, its trip gets anchors that:
//  - ahead (the vessel is further along than drawn): carry it from the drawn position to the new one
//    at up to catchUpMps extra, within minGlideS–maxGlideS;
//  - behind: hold it where it was drawn until the new timetable catches up (≤ maxHoldS);
// then follow `next` exactly. Tiny differences are left alone; big ones (> snapM), or ones that
// cross between trips other than leaving the dock, still jump. Pure: the result is a function of
// (plan, shown, next, K); the caller uses it for display times in [K, until] and `next` otherwise.

import { distM } from "../geo.ts";
import {
  schedAt,
  scheduledVehicles,
  shiftAt,
  type PreparedPlan,
  type ScheduleCorrections,
  type VehicleState,
} from "../schedule/engine.ts";

export interface GlideConfig {
  /** Differences smaller than this aren't smoothed (m). */
  minM: number;
  /** Differences larger than this jump (m). */
  snapM: number;
  /** Extra speed while catching up (m/s). */
  catchUpMps: number;
  minGlideS: number;
  maxGlideS: number;
  /** A vessel drawn ahead holds at most this long; longer, it jumps back (s). */
  maxHoldS: number;
}

export interface Glide {
  corrections: ScheduleCorrections;
  /** Service-day second after which `corrections` equals `next` (use `next` from then on). */
  until: number;
}

type Anchors = { sched: number; shift: number }[];

/** @param k service-day second at which `next` became known. */
export function glideCorrections(
  pp: PreparedPlan,
  serviceDate: string,
  route: string,
  shown: ScheduleCorrections | undefined,
  next: ScheduleCorrections,
  k: number,
  cfg: GlideConfig,
): Glide {
  const routes = new Set([route]);
  const byId = (vs: VehicleState[]) => new Map(vs.map((v) => [v.id, v]));
  const before = byId(
    scheduledVehicles(pp, { serviceDate, sec: k, routes }, shown),
  );
  const after = byId(
    scheduledVehicles(pp, { serviceDate, sec: k, routes }, next),
  );
  const trips = new Map(next.trips);
  let until = k;

  for (const [id, nv] of after) {
    const ov = before.get(id);
    if (!ov) continue;
    const gap = distM([ov.lon, ov.lat], [nv.lon, nv.lat]);
    if (gap < cfg.minM || gap > cfg.snapM) continue;
    const trip = pp.tripIndex.get(nv.tripId);
    if (!trip) continue;
    const start = trip.trip.start;
    const end = trip.arr[trip.arr.length - 1]!;
    // Where the vessel was drawn, as a scheduled time on the new trip: on that trip, or docked at
    // its origin on the previous trip (its layover).
    let sOld: number;
    if (ov.tripId === trip.trip.id)
      sOld = Math.min(
        end,
        Math.max(start, schedAt(shown?.trips.get(trip.trip.id)?.anchors, k)),
      );
    else if (
      pp.tripIndex.get(ov.tripId)?.next === trip
      && ov.status === "layover"
    )
      sOld = start;
    else continue;

    const nAnchors: Anchors | undefined = next.trips.get(trip.trip.id)?.anchors;
    const sNew = schedAt(nAnchors, k);
    let anchors: Anchors;
    let glideEnd: number;
    if (sNew > sOld) {
      const g = Math.min(
        cfg.maxGlideS,
        Math.max(cfg.minGlideS, gap / cfg.catchUpMps),
      );
      // s2: where `next` has the vessel when the glide ends; from there on, `next` exactly.
      const s2 = schedAt(nAnchors, k + g);
      if (s2 <= sOld) continue;
      anchors = [
        { sched: sOld, shift: k - sOld },
        { sched: s2, shift: k + g - s2 },
        ...(nAnchors ?? []).filter((a) => a.sched > s2),
      ];
      glideEnd = k + g;
    } else if (sNew < sOld) {
      // Hold at sOld until `next` reaches it.
      const k2 = sOld + shiftAt(nAnchors, sOld);
      if (k2 - k > cfg.maxHoldS) continue;
      const s1 = sOld + 0.01;
      anchors = [
        { sched: sOld, shift: k - sOld },
        { sched: s1, shift: k2 - s1 },
        ...(nAnchors ?? []).filter((a) => a.sched > s1),
      ];
      glideEnd = k2;
    } else continue;

    const entry = next.trips.get(trip.trip.id) ?? { anchors: [], observed: [] };
    trips.set(trip.trip.id, { ...entry, anchors });
    until = Math.max(until, glideEnd);
  }
  return { corrections: { ...next, trips }, until };
}
