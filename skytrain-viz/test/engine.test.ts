import { describe, expect, it } from 'vitest';
import { preparePlan, scheduledVehicles } from '../src/core/schedule/engine.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';

const kin: KinematicsConfig = {
  modes: {
    skytrain: { accel: 1, decel: 1, maxSpeed: 80, minCruiseFraction: 0.6, dwell: 20, length: 68, width: 3, profile: 'trapezoid' },
    bus: { accel: 1, decel: 1, maxSpeed: 60, minCruiseFraction: 0, dwell: 0, length: 18, width: 2.6, profile: 'linear' },
  },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// A 2 km straight line with stops at 0, 1000, 2000 m; one train out and back in the same block.
const plan: ServicePlan = {
  schema: 1,
  feedVersion: 'test',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'expo', label: 'Expo', kind: 'skytrain', mode: 'skytrain', color: '#0033a0', textColor: '#fff', gtfsRouteId: '1' }],
  stops: [
    { id: 'A', name: 'A', lon: -123.1, lat: 49.25 },
    { id: 'B', name: 'B', lon: -123.08625, lat: 49.25 },
    { id: 'C', name: 'C', lon: -123.0725, lat: 49.25 },
  ],
  stations: [],
  shapes: {
    east: [
      [-123.1, 49.25],
      [-123.0725, 49.25],
    ],
    west: [
      [-123.0725, 49.25],
      [-123.1, 49.25],
    ],
  },
  patterns: [
    { id: 0, route: 'expo', direction: 0, shape: 'east', stops: [0, 1, 2], dist: [0, 1000, 2000] },
    { id: 1, route: 'expo', direction: 1, shape: 'west', stops: [2, 1, 0], dist: [0, 1000, 2000] },
  ],
  trips: [
    // 23:50 → 23:54, then back 23:58 → 24:02 (after midnight on the same service day).
    { id: 't1', pattern: 0, service: 'wk', block: 'b1', headsign: 'To C', start: 85800, arr: [0, 120, 240] },
    { id: 't2', pattern: 1, service: 'wk', block: 'b1', headsign: 'To A', start: 86280, arr: [0, 120, 240] },
  ],
  calendar: {
    calendar: [{ serviceId: 'wk', days: [true, true, true, true, true, false, false], start: '20260901', end: '20261231' }],
    exceptions: [],
  },
};

const pp = preparePlan(plan, kin);
const at = (sec: number, serviceDate = '20260928') => scheduledVehicles(pp, { serviceDate, sec });

describe('scheduledVehicles', () => {
  it('shows nothing before the first departure or on days without service', () => {
    expect(at(85799)).toHaveLength(0);
    expect(at(85900, '20260927')).toHaveLength(0); // Sunday
  });
  it('dwells at intermediate stops around the scheduled time', () => {
    const [v] = at(85800 + 120);
    expect(v?.status).toBe('dwell');
    expect(v?.stopName).toBe('B');
    expect(v?.lon).toBeCloseTo(-123.08625, 4);
  });
  it('moves between stops, heading east, and reports speed', () => {
    const [v] = at(85800 + 60);
    expect(v?.status).toBe('moving');
    expect(v?.lon).toBeGreaterThan(-123.1);
    expect(v?.lon).toBeLessThan(-123.08625);
    expect(v?.bearing).toBeCloseTo(90, 0);
    expect(v?.speed).toBeGreaterThan(0);
  });
  it('holds the vehicle at the terminus during layover, keeping one vehicle id', () => {
    const lay = at(85800 + 240 + 60);
    expect(lay).toHaveLength(1);
    expect(lay[0]?.status).toBe('layover');
    const back = at(86280 + 60);
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe(lay[0]?.id);
    expect(back[0]?.bearing).toBeCloseTo(270, 0);
  });
  it('runs trips past midnight on the service day that scheduled them', () => {
    const [v] = at(86400 + 60);
    expect(v?.tripId).toBe('t2');
    expect(at(86280 + 241)).toHaveLength(0);
  });
  it('filters by route', () => {
    expect(scheduledVehicles(pp, { serviceDate: '20260928', sec: 85860, routes: new Set(['99']) })).toHaveLength(0);
  });
});
