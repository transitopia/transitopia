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
//
// The server has every fix, so it watches each bus's current run as polls arrive (FreezeWatch) and,
// for a bus whose latest fixes are frozen, sends its last real fix with each snapshot (live and
// recorded: RtSnapshot.frozen). The timeline puts that fix in place of the frozen ones, so a bus
// frozen since before the data begins is still estimated from where it really was rather than
// dropped (`openStart` remains for when the server doesn't know: recordings from before that, or a
// freeze already under way when the server started).

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
/** Whether fix f, at the same position as the fix before it (prev), gives its run away as suspect. */
function givesAway(
  prev: FreezeFix,
  f: FreezeFix,
  cfg: FrozenGpsConfig,
): boolean {
  return (
    f.tripId !== undefined
    && f.tripId === prev.tripId
    && f.stop !== prev.stop
    && f.stopAt !== undefined
    && distM(f.stopAt, [f.lon, f.lat]) > cfg.stopFarM
  );
}

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
      if (!suspect && givesAway(fixes[k - 1]!, f, cfg)) suspect = true;
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

interface WatchedRun<T> {
  /** Its first fix's value; undefined when the run began before the watch knew the vehicle. */
  first: T | undefined;
  /** Its latest fix. */
  last: FreezeFix;
  lastTs: number;
  suspect: boolean;
}

/**
 * frozenFixes for fixes arriving one poll at a time (the server's live feed): each vehicle's current
 * run of fixes at the same position, and whether it's suspect. A suspect run still going on is
 * frozen, as frozenFixes takes it, and its first fix is the bus's last real one. `T` is what the
 * caller keeps of a fix (the server: the RtVehicle). One small entry per vehicle in the feed.
 */
export class FreezeWatch<T> {
  private runs = new Map<string, WatchedRun<T>>();
  private cfg: FrozenGpsConfig;

  constructor(cfg: FrozenGpsConfig) {
    this.cfg = cfg;
  }

  /** A vehicle's fix at `ts` (ms). Repeats of its latest fix time, and older fixes, are ignored. */
  add(id: string, ts: number, fix: FreezeFix, value: T): void {
    const r = this.runs.get(id);
    if (r && ts <= r.lastTs) return;
    if (r && fix.lat === r.last.lat && fix.lon === r.last.lon) {
      if (!r.suspect && givesAway(r.last, fix, this.cfg)) r.suspect = true;
      r.last = fix;
      r.lastTs = ts;
      return;
    }
    this.runs.set(id, { first: value, last: fix, lastTs: ts, suspect: false });
  }

  /**
   * A vehicle seen without its earlier fixes (e.g. in the last snapshot recorded before a restart):
   * its run began at an unknown time, unless `lastReal` (the snapshot's RtSnapshot.frozen) says it
   * is frozen since then.
   */
  resume(id: string, ts: number, fix: FreezeFix, lastReal?: T): void {
    this.runs.set(id, {
      first: lastReal,
      last: fix,
      lastTs: ts,
      suspect: lastReal !== undefined,
    });
  }

  /** The vehicle's last real fix, when its latest fixes are frozen and the watch saw where that began. */
  lastReal(id: string): T | undefined {
    const r = this.runs.get(id);
    return r?.suspect ? r.first : undefined;
  }
}
