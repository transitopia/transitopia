import { describe, expect, it } from 'vitest';
import { reconcileScheduled } from '../src/core/corrections/reconcile.ts';
import type { Observation } from '../src/core/corrections/types.ts';
import { preparePlan, scheduledVehicles } from '../src/core/schedule/engine.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';

const kin: KinematicsConfig = {
  modes: { ferry: { accel: 0.3, decel: 0.3, maxSpeed: 25, minCruiseFraction: 0, dwell: 0, length: 34, width: 10, profile: 'linear' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};

// A ferry shuttling L → W (14:02 → 14:14) and back W → L (14:16 → 14:28), one vessel (block).
const H14 = 14 * 3600;
const plan: ServicePlan = {
  schema: 1,
  feedVersion: 'test',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'seabus', label: 'SeaBus', kind: 'shape', mode: 'ferry', color: '#000', textColor: '#fff', gtfsRouteId: '998' }],
  stops: [
    { id: 'L', name: 'Lonsdale Quay', lon: -123.08, lat: 49.31 },
    { id: 'WS', name: 'Waterfront Station Southbound', lon: -123.11, lat: 49.287, parent: 'W' },
    { id: 'WN', name: 'Waterfront Station Northbound', lon: -123.11, lat: 49.287, parent: 'W' },
  ],
  stations: [],
  shapes: { s: [[-123.08, 49.31], [-123.11, 49.287]], n: [[-123.11, 49.287], [-123.08, 49.31]] },
  patterns: [
    { id: 0, route: 'seabus', direction: 0, shape: 's', stops: [0, 1], dist: [0, 3300] },
    { id: 1, route: 'seabus', direction: 1, shape: 'n', stops: [2, 0], dist: [0, 3300] },
  ],
  trips: [
    { id: 'down', pattern: 0, service: 'sa', block: 'v1', headsign: 'To Waterfront', start: H14 + 120, arr: [0, 720] },
    { id: 'up', pattern: 1, service: 'sa', block: 'v1', headsign: 'To Lonsdale', start: H14 + 960, arr: [0, 720] },
  ],
  calendar: { calendar: [{ serviceId: 'sa', days: [false, false, false, false, false, true, false], start: '20260901', end: '20261231' }], exceptions: [] },
};

const pp = preparePlan(plan, kin);
const obs: Observation[] = [
  { kind: 'at_platform', date: '2026-09-26', stop: 'Waterfront', line: 'seabus', event: 'arrive', time: '2026-09-26T14:15:38-07:00', source: 'test', consist: { name: 'Burrard Pacific Breeze' } },
  { kind: 'at_platform', date: '2026-09-26', stop: 'Waterfront', line: 'seabus', event: 'depart', time: '2026-09-26T14:18:25-07:00', source: 'test' },
  { kind: 'at_platform', date: '2026-09-26', stop: 'Lonsdale Quay', line: 'seabus', event: 'arrive', time: '2026-09-26T14:29:17-07:00', source: 'test' },
];
const corr = reconcileScheduled(pp, obs, '20260926');
const at = (sec: number) => scheduledVehicles(pp, { serviceDate: '20260926', sec }, corr);

describe('reconcileScheduled', () => {
  it('matches arrival and departure sightings to the right trips at a terminus', () => {
    expect(corr.unmatched).toHaveLength(0);
    expect(corr.trips.get('down')?.anchors.map((a) => a.shift)).toEqual([98]);
    expect(corr.trips.get('up')?.anchors.map((a) => a.shift)).toEqual([145, 77]);
    expect(corr.consists.size).toBe(1);
  });

  it('shifts the vessel, holds it at the terminal until the late departure, and names it', () => {
    // 14:15:00: scheduled to have arrived, but still 38 s out.
    const approaching = at(H14 + 900);
    expect(approaching).toHaveLength(1);
    expect(approaching[0]!.status).not.toBe('stopped');
    expect(approaching[0]!.provenance).toBe('observed');
    expect(approaching[0]!.consist?.name).toBe('Burrard Pacific Breeze');
    // 14:17:30: scheduled to have left, but still at the berth.
    const held = at(H14 + 1050);
    expect(held).toHaveLength(1);
    expect(held[0]!.tripId).toBe('down');
    expect(held[0]!.status).toBe('layover');
    // 14:20: on the way back, 145 s late; one vessel throughout.
    const back = at(H14 + 1200);
    expect(back).toHaveLength(1);
    expect(back[0]!.tripId).toBe('up');
    // Late by 145 s at departure, 77 s on arrival: in between, part-way.
    expect(back[0]!.delay).toBeLessThan(145);
    expect(back[0]!.delay).toBeGreaterThan(77);
    expect(at(H14 + 1680 + 70)[0]!.status).not.toBe('stopped');
    // Past the corrected end.
    expect(at(H14 + 1680 + 78)).toHaveLength(0);
  });

  it('leaves other days alone', () => {
    const none = reconcileScheduled(pp, obs, '20260919');
    expect(none.trips.size).toBe(0);
  });
});
