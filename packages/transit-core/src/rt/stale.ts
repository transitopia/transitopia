// Frozen GPS (packages/transit-core/DESIGN.md#buses): TransLink's GTFS-RT sometimes keeps sending the
// same position for a bus for minutes or hours while its fix time, reported stop and even its trip
// move on (2026-11-07: bus 9735 on the 240 reported Marine Dr, North Vancouver, from 09:59:50 to
// 10:28:02 while TransLink's stop went over the Lions Gate to Georgia & Homer, where its GPS came
// back; 250-650 buses a day). Such fixes say nothing about where the bus is, so they're dropped:
// from the timeline (the bus is estimated from its last real fix instead) and from observed stop
// times.
//
// A run is consecutive fixes at exactly the same position (a working GPS jitters by metres even on a
// standing bus; recorded fixes are rounded to ~1 m). It's suspect when a fix in it reports a
// different stop of the same trip from the fix before, further than `stopFarM` from the position: a
// standing bus's stop doesn't usually move on. A change of trip alone doesn't count: a bus starting
// its next trip stands where it is while that trip can start far away.
//
// TransLink's stop sometimes moves on while the bus really stands still (seen: buses laying over at
// a terminus for up to 80 min while their reported stop ran through their trips), so a suspect run
// that has ended is frozen only if the bus reappears more than `movedM` from where it stood: on
// 2026-10-20, 11-06 and 11-07, buses after a suspect run reappeared either within 150 m (it stood
// there) or further than 300 m. A run still going on (live, the latest fixes) is taken as frozen.
// Every fix after a frozen run's first is dropped, including those before the one that gave it
// away; the first is kept: it was where the bus was then. Unless the fixes start in the middle of
// the run (`openStart`: the data begins with the bus already there, e.g. the live buffer since the
// page opened, or a loaded recorded hour): then where the run began is unknown, and its first fix
// may be frozen too, so it goes as well (seen: bus 8127, 2026-11-08, frozen from 10:38, jumped back
// to its frozen spot when a page opened at 10:51 switched to live data).

import { distM, type LonLat } from "../geo.ts";

export interface FrozenGpsConfig {
  /** A run is suspect when a fix in it reports a new stop further than this from its position (m). */
  stopFarM: number;
  /** ... and frozen, once it has ended, when the next fix is further than this from it (m). */
  movedM: number;
}

/** What frozenFixes needs from a fix. */
export interface FreezeFix {
  lat: number;
  lon: number;
  tripId: string | undefined;
  /** Its reported stop (stop_id, or stop_sequence: anything that changes when the stop does). */
  stop: string | undefined;
  /** Where that stop is, when known. */
  stopAt: LonLat | undefined;
}

/**
 * Indexes of one vehicle's fixes (in time order, one per fix time) whose position is frozen.
 * `openStart`: the first fix may be partway through a run (see above).
 */
export function frozenFixes(
  fixes: readonly FreezeFix[],
  cfg: FrozenGpsConfig,
  openStart = false,
): Set<number> {
  const out = new Set<number>();
  let start = 0;
  let suspect = false;
  for (let k = 1; k <= fixes.length; k++) {
    const a = fixes[start]!;
    const f = fixes[k];
    if (f && f.lat === a.lat && f.lon === a.lon) {
      const prev = fixes[k - 1]!;
      if (
        !suspect
        && f.tripId !== undefined
        && f.tripId === prev.tripId
        && f.stop !== prev.stop
        && f.stopAt
        && distM(f.stopAt, [f.lon, f.lat]) > cfg.stopFarM
      )
        suspect = true;
      continue;
    }
    if (suspect && (!f || distM([a.lon, a.lat], [f.lon, f.lat]) > cfg.movedM))
      for (let j = start === 0 && openStart ? 0 : start + 1; j < k; j++)
        out.add(j);
    start = k;
    suspect = false;
  }
  return out;
}
