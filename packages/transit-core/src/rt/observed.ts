// Observed stop times (docs/DESIGN.md#retention-and-statistics): when a vehicle actually served each stop of a trip, from
// its recorded GTFS-RT fixes. Kept indefinitely, they're the atom behind every statistic, so each
// carries its precision: the time between the two fixes it was interpolated from (0 when the vehicle
// reported itself stopped at that stop).
//
// Fixes come every 1–5 minutes (the request budget), so most stops fall between two fixes. Each fix
// is projected onto the trip's shape (searching forward, so loops and out-and-back shapes don't snap
// back), and a stop's time is where the vehicle passed its distance along the shape, linearly between
// the fixes either side. That approximates the departure (at the first stop, the last fix still
// there is before the bus leaves); at the last stop it's the arrival. Stops whose bracketing fixes are too far apart in time are left out
// rather than guessed.

import { cumulativeLengths, projectOnto, type LonLat } from "../geo.ts";

export interface ObservedConfig {
  /** A fix further than this from the shape is ignored (m). */
  maxOffsetM: number;
  /** Don't interpolate a stop between fixes further apart than this (s). */
  maxGapS: number;
  /** A fix within this of a stop, reported STOPPED_AT it, times the stop exactly (m). */
  stopToleranceM: number;
  /** Moving back along the shape by more than this is GPS noise or a new pass: the fix is dropped (m). */
  backtrackM: number;
}

export interface TripStop {
  seq: number;
  stopId: string;
  lon: number;
  lat: number;
  /** Scheduled departure, seconds since the service day's start. */
  schedS: number;
  timepoint: boolean;
}

export interface TripFix {
  /** Epoch ms of the fix. */
  ts: number;
  lat: number;
  lon: number;
  vehicleId: string;
  /** GTFS-RT VehicleStopStatus (1 = STOPPED_AT). */
  status?: number | undefined;
  stopSeq?: number | undefined;
}

export interface ObservedStop {
  seq: number;
  stopId: string;
  schedS: number;
  timepoint: boolean;
  /** Epoch ms. */
  observedAt: number;
  precisionS: number;
  vehicleId: string;
}

const STOPPED_AT = 1;

/** Observed times at a trip's stops (only those the fixes can place). */
export function observeTrip(
  shape: LonLat[],
  stops: TripStop[],
  fixes: TripFix[],
  cfg: ObservedConfig,
): ObservedStop[] {
  if (shape.length < 2 || !stops.length || fixes.length < 2) return [];
  const cum = cumulativeLengths(shape);
  // Stops along the shape, in order.
  let from = 0;
  const stopAlong = stops.map((s) => {
    const p = projectOnto(shape, cum, [s.lon, s.lat], from, cfg.maxOffsetM);
    from = p.along;
    return p.along;
  });
  // Fixes along the shape: in time order, one per timestamp, never going back.
  const sorted = [...fixes].sort((a, b) => a.ts - b.ts);
  const track: { t: number; d: number; f: TripFix }[] = [];
  let last = 0;
  for (const f of sorted) {
    if (track.length && f.ts === track[track.length - 1]!.t) continue;
    const p = projectOnto(
      shape,
      cum,
      [f.lon, f.lat],
      Math.max(0, last - cfg.backtrackM),
      cfg.maxOffsetM,
    );
    if (p.offset > cfg.maxOffsetM) continue;
    if (p.along < last - cfg.backtrackM) continue;
    const d = Math.max(p.along, last);
    track.push({ t: f.ts, d, f });
    last = d;
  }
  if (track.length < 2) return [];
  const out: ObservedStop[] = [];
  let j = 0;
  for (let k = 0; k < stops.length; k++) {
    const s = stops[k]!;
    const along = stopAlong[k]!;
    // Reported stopped at this stop: the last such fix is when it left.
    const at = track.filter(
      (x) =>
        x.f.status === STOPPED_AT
        && x.f.stopSeq === s.seq
        && Math.abs(x.d - along) <= cfg.stopToleranceM,
    );
    if (at.length) {
      const x = at[at.length - 1]!;
      out.push({
        ...pick(s),
        observedAt: x.t,
        precisionS: 0,
        vehicleId: x.f.vehicleId,
      });
      continue;
    }
    // The first fix clearly past the stop (a bus waiting at it can stand a few metres beyond its
    // projected point), and the one before it. The last stop is never passed: there, the arrival.
    const isLast = k === stops.length - 1;
    const past =
      isLast ? along - cfg.stopToleranceM : along + cfg.stopToleranceM;
    while (
      j < track.length
      && (isLast ? track[j]!.d < past : track[j]!.d <= past)
    )
      j++;
    if (j === 0 || j >= track.length) continue;
    const a = track[j - 1]!;
    const b = track[j]!;
    const gapS = (b.t - a.t) / 1000;
    if (gapS > cfg.maxGapS) continue;
    const f =
      b.d > a.d ? Math.min(1, Math.max(0, (past - a.d) / (b.d - a.d))) : 0;
    out.push({
      ...pick(s),
      observedAt: Math.round(a.t + (b.t - a.t) * f),
      precisionS: Math.round(gapS),
      vehicleId: b.f.vehicleId,
    });
  }
  return out;
}

const pick = (s: TripStop) => ({
  seq: s.seq,
  stopId: s.stopId,
  schedS: s.schedS,
  timepoint: s.timepoint,
});
