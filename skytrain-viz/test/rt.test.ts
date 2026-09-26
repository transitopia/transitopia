import { describe, expect, it } from 'vitest';
import { coverageContains, decodeSnapshot, encodeSnapshot, extendCoverage, type RtSnapshot } from '../src/core/rt/types.ts';
import { RtTimeline } from '../src/core/rt/timeline.ts';
import { preparePlan } from '../src/core/schedule/engine.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';

const kin: KinematicsConfig = {
  modes: { bus: { accel: 1, decel: 1, maxSpeed: 60, minCruiseFraction: 0, dwell: 0, length: 18, width: 2.6, profile: 'linear' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// An L-shaped bus route: 1 km east, then 1 km north. Straight-line interpolation between fixes on
// either side of the corner would cut the corner; along-shape interpolation must not.
const corner: [number, number] = [-123.08625, 49.25];
const plan: ServicePlan = {
  schema: 1,
  feedVersion: 't',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: '99', label: '99', kind: 'bus', mode: 'bus', color: '#f76707', textColor: '#fff', gtfsRouteId: '6641' }],
  stops: [
    { id: 's1', name: 'Start', lon: -123.1, lat: 49.25 },
    { id: 's2', name: 'End', lon: corner[0], lat: 49.259 },
  ],
  stations: [],
  shapes: { L: [[-123.1, 49.25], corner, [corner[0], 49.259]] },
  patterns: [{ id: 0, route: '99', direction: 0, shape: 'L', stops: [0, 1], dist: [0, 2000] }],
  trips: [{ id: 'trip1', pattern: 0, service: 'wk', headsign: 'To End', start: 30000, arr: [0, 400] }],
  calendar: { calendar: [], exceptions: [] },
};
const pp = preparePlan(plan, kin);

const T0 = Date.UTC(2026, 8, 28, 16, 0, 0);
function snap(offsetS: number, vehicles: [number, number][], id = 'bus1'): RtSnapshot {
  return {
    fetchedAt: T0 + offsetS * 1000 + 3000,
    headerTs: T0 + offsetS * 1000,
    vehicles: vehicles.map(([lon, lat]) => ({ id, routeKey: '99', tripId: 'trip1', lon, lat, ts: T0 + offsetS * 1000, label: '23005' })),
  };
}
const opts = { maxInterpolateS: 180, maxExtrapolateS: 90, source: 'test' };

describe('RtTimeline', () => {
  // Fix 1: 200 m before the corner; fix 2: 200 m after it, 60 s later.
  const before: [number, number] = [corner[0] - 0.00275, 49.25];
  const after: [number, number] = [corner[0], 49.25 + 0.0018];
  const tl = new RtTimeline([snap(0, [before]), snap(60, [after])], pp, kin, opts);

  it('interpolates along the shape, through the corner', () => {
    const [v] = tl.vehiclesAt(T0 + 30_000);
    expect(v?.provenance).toBe('interpolated');
    expect(v?.lon).toBeCloseTo(corner[0], 4);
    expect(v?.lat).toBeCloseTo(corner[1], 4);
    expect(v?.label).toBe('23005');
    expect(v?.id).toBe('rt:bus1');
  });
  it('shows nothing before the first fix', () => {
    expect(tl.vehiclesAt(T0 - 1000)).toHaveLength(0);
  });
  it('dead-reckons along the shape after the last fix, then gives up', () => {
    const [v] = tl.vehiclesAt(T0 + 90_000);
    expect(v?.provenance).toBe('observed');
    expect(v?.lat).toBeGreaterThan(after[1]);
    expect(v?.lon).toBeCloseTo(corner[0], 5);
    expect(tl.vehiclesAt(T0 + 60_000 + 91_000)).toHaveLength(0);
  });
  it('hides a vehicle once a later snapshot no longer includes it', () => {
    const gone = new RtTimeline([snap(0, [before]), snap(20, [], 'bus1')], pp, kin, opts);
    expect(gone.vehiclesAt(T0 + 10_000)).toHaveLength(1);
    expect(gone.vehiclesAt(T0 + 30_000)).toHaveLength(0);
  });
  it('does not interpolate across long gaps', () => {
    const gap = new RtTimeline([snap(0, [before]), snap(600, [after])], pp, kin, opts);
    expect(gap.vehiclesAt(T0 + 300_000)).toHaveLength(0);
  });
  it('filters by route', () => {
    expect(tl.vehiclesAt(T0 + 30_000, new Set(['R4']))).toHaveLength(0);
  });
});

describe('snapshot encoding', () => {
  it('round-trips compactly', () => {
    const s = snap(0, [[-123.123456789, 49.2]]);
    s.vehicles[0]!.delay = -180;
    s.vehicles[0]!.status = 2;
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.fetchedAt).toBe(s.fetchedAt);
    expect(d.vehicles[0]).toMatchObject({ id: 'bus1', routeKey: '99', tripId: 'trip1', delay: -180, status: 2, label: '23005' });
    expect(d.vehicles[0]!.lon).toBeCloseTo(-123.12346, 5);
    expect(d.vehicles[0]!.bearing).toBeUndefined();
  });
});

describe('coverage', () => {
  it('merges points within the gap and splits beyond it', () => {
    const iv: [number, number][] = [];
    for (const t of [0, 20, 40, 60]) extendCoverage(iv, t * 1000, 75_000);
    extendCoverage(iv, 300_000, 75_000);
    expect(iv).toEqual([
      [0, 60_000],
      [300_000, 300_000],
    ]);
    expect(coverageContains(iv, 30_000)).toBe(true);
    expect(coverageContains(iv, 200_000)).toBe(false);
    expect(coverageContains(iv, 200_000, 100_000)).toBe(true);
  });
  it('handles out-of-order points', () => {
    const iv: [number, number][] = [[100_000, 200_000]];
    extendCoverage(iv, 50_000, 75_000);
    expect(iv).toEqual([[50_000, 200_000]]);
  });
});
