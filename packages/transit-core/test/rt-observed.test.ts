import { describe, expect, it } from "vitest";
import {
  observeTrip,
  type TripFix,
  type TripStop,
} from "../src/rt/observed.ts";
import type { LonLat } from "../src/geo.ts";

const cfg = {
  maxOffsetM: 100,
  maxGapS: 600,
  stopToleranceM: 30,
  backtrackM: 50,
};
// A straight east-west street: 0.001° of longitude ≈ 72.6 m at 49.25° N.
const LAT = 49.25;
const lonAt = (m: number) => -123.1 + m / 72_600;
const shape: LonLat[] = [
  [lonAt(0), LAT],
  [lonAt(3000), LAT],
];
const stop = (seq: number, m: number, schedS: number): TripStop => ({
  seq,
  stopId: `s${seq}`,
  lon: lonAt(m),
  lat: LAT,
  schedS,
  timepoint: seq === 1,
});
const T0 = Date.parse("2026-09-29T15:00:00Z");
const fix = (s: number, m: number, extra: Partial<TripFix> = {}): TripFix => ({
  ts: T0 + s * 1000,
  lat: LAT + 0.00001,
  lon: lonAt(m),
  vehicleId: "bus1",
  ...extra,
});

describe("observeTrip", () => {
  const stops = [
    stop(1, 0, 0),
    stop(2, 1000, 120),
    stop(3, 2000, 240),
    stop(4, 3000, 360),
  ];

  it("interpolates stops between fixes, with the gap as precision", () => {
    const rows = observeTrip(
      shape,
      stops,
      [fix(0, 0), fix(60, 0), fix(120, 900), fix(240, 2100), fix(300, 2990)],
      cfg,
    );
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    // Left the first stop between 60 s (still there) and 120 s.
    expect(bySeq.get(1)!.precisionS).toBe(60);
    expect((bySeq.get(1)!.observedAt - T0) / 1000).toBeCloseTo(62, 0);
    // Passed stop 2 (1,000 m + tolerance) between 900 m at 120 s and 2,100 m at 240 s.
    expect((bySeq.get(2)!.observedAt - T0) / 1000).toBeCloseTo(133, 0);
    expect(bySeq.get(2)!.precisionS).toBe(120);
    // The last stop: arrival within the tolerance (2,970 m), between 2,100 m and 2,990 m.
    expect((bySeq.get(4)!.observedAt - T0) / 1000).toBeCloseTo(298.65, 1);
  });

  it("uses a STOPPED_AT report at the stop exactly", () => {
    const rows = observeTrip(
      shape,
      stops,
      [
        fix(0, 0),
        fix(100, 1005, { status: 1, stopSeq: 2 }),
        fix(130, 1010, { status: 1, stopSeq: 2 }),
        fix(200, 1600),
      ],
      cfg,
    );
    const s2 = rows.find((r) => r.seq === 2)!;
    expect(s2.precisionS).toBe(0);
    expect((s2.observedAt - T0) / 1000).toBe(130);
  });

  it("leaves out stops between fixes too far apart, and ignores fixes off the route or going back", () => {
    const rows = observeTrip(
      shape,
      stops,
      [
        fix(0, 0),
        fix(30, 200),
        fix(60, 100, { lat: LAT + 0.01 }),
        fix(90, 50),
        fix(1000, 2500),
      ],
      cfg,
    );
    expect(rows.map((r) => r.seq)).toEqual([1]);
  });
});
