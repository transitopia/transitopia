import { describe, expect, it } from 'vitest';
import { TrackGraph } from '../src/infra/graph.ts';
import { dispatch, type DispatchConfig } from '../src/dispatch/dispatch.ts';
import { TrainPlayback } from '../src/movement/playback.ts';
import { preparePlan } from '../src/schedule/engine.ts';
import type { InfraCollection, InfraFeature, NodeKind, SegmentEnd, SegmentKind } from '../src/infra/types.ts';
import type { MovementsFile } from '../src/movement/types.ts';
import type { ServicePlan } from '../src/plan/types.ts';
import type { KinematicsConfig } from '../src/movement/kinematics.ts';
import type { LonLat } from '../src/geo.ts';

// Double track at A merging into a single track to stub station B:
//
//   N (A1 at x=100) ──╮
//                      J ── s (single track, B at x=1900) ── buffer
//   S (A2 at x=100) ──╯
const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [-123 + x / M_PER_DEG_LON, 49.25 + y / 110_574];
function seg(id: string, kind: SegmentKind, from: string, to: string, coords: LonLat[], length: number): InfraFeature {
  return { type: 'Feature', properties: { type: 'segment', id, kind, lines: ['expo'], from, to, length, osmWay: 0 }, geometry: { type: 'LineString', coordinates: coords } };
}
function node(id: string, kind: NodeKind, at: LonLat, turns: [SegmentEnd, SegmentEnd][]): InfraFeature {
  return { type: 'Feature', properties: { type: 'node', id, kind, turns, osmNode: 0 }, geometry: { type: 'Point', coordinates: at } };
}
const fc: InfraCollection = {
  type: 'FeatureCollection',
  metadata: { source: 'test', generatedAt: '' },
  features: [
    seg('N', 'main', 'N0', 'J', [pt(0, 4), pt(1000, 0)], 1000),
    seg('S', 'main', 'S0', 'J', [pt(0, -4), pt(1000, 0)], 1000),
    seg('s', 'main', 'J', 'B0', [pt(1000), pt(2000)], 1000),
    node('N0', 'buffer', pt(0, 4), []),
    node('S0', 'buffer', pt(0, -4), []),
    node('B0', 'buffer', pt(2000), []),
    node('J', 'switch', pt(1000), [
      ['N:1', 's:0'],
      ['S:1', 's:0'],
    ]),
  ],
};
const g = TrackGraph.fromCollection(fc);

const kin: KinematicsConfig = {
  modes: { skytrain: { accel: 1, decel: 1, maxSpeed: 80, minCruiseFraction: 0.6, dwell: 20, length: 68, width: 3, profile: 'trapezoid' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};
const config: DispatchConfig = { stepS: 1, safetyMarginM: 30, foulingM: 15, minHoldS: 40, maxWaitS: 900, crossingBufferS: 30, singleTrackHeadwayS: 720, revenueFirst: true };
const opts = { config, kin, deadheadSpeedFactor: 0.55, turnbackSpeedFactor: 0.8 };

const plan: ServicePlan = {
  schema: 1,
  feedVersion: 't',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'expo', label: 'Expo', kind: 'skytrain', mode: 'skytrain', color: '#0033a0', textColor: '#fff', gtfsRouteId: '1' }],
  stops: [
    { id: 'A1', name: 'A Station @ Platform 1', lon: pt(100, 4)[0], lat: pt(100, 4)[1], platform: '1' },
    { id: 'A2', name: 'A Station @ Platform 2', lon: pt(100, -4)[0], lat: pt(100, -4)[1], platform: '2' },
    { id: 'B', name: 'B Station @ Platform 1', lon: pt(1900)[0], lat: pt(1900)[1], platform: '1' },
  ],
  stations: [
    { id: 'A', name: 'A', lon: pt(100)[0], lat: pt(100)[1] },
    { id: 'Bs', name: 'B', lon: pt(1900)[0], lat: pt(1900)[1] },
  ],
  shapes: { ab: [pt(100), pt(1900)], ba: [pt(1900), pt(100)] },
  patterns: [
    { id: 0, route: 'expo', direction: 0, shape: 'ab', stops: [0, 2], dist: [0, 1800] },
    { id: 1, route: 'expo', direction: 1, shape: 'ba', stops: [2, 1], dist: [0, 1800] },
  ],
  trips: [
    { id: 'up', pattern: 0, service: 'wk', headsign: 'To B', start: 8 * 3600, arr: [0, 150] },
    { id: 'down', pattern: 1, service: 'wk', headsign: 'To A', start: 8 * 3600, arr: [0, 150] },
  ],
  calendar: { calendar: [], exceptions: [] },
} as unknown as ServicePlan;
const pp = preparePlan(plan, kin);
/** A trip's modelled arrival (the build starts the next hold there). */
const arrival = (trip: string) => pp.tripIndex.get(trip)!.arr.at(-1)!;

/** Hand-built runs: one train waits at A1 for the up trip, one at B for the down trip. */
function movements(trips: ('up' | 'down')[]): MovementsFile {
  const runs: MovementsFile['runs'] = [];
  if (trips.includes('up')) {
    runs.push({
      id: 'expo-001',
      line: 'expo',
      events: [
        { k: 'hold', t0: 8 * 3600 - 60, t1: 8 * 3600, seg: 0, offset: 100, dir: 1, kind: 'layover' },
        { k: 'trip', trip: 'up', pattern: 0 },
        { k: 'hold', t0: arrival('up'), t1: 8 * 3600 + 600, seg: 2, offset: 900, dir: 1, kind: 'layover' },
      ],
    });
  }
  if (trips.includes('down')) {
    runs.push({
      id: 'expo-002',
      line: 'expo',
      events: [
        { k: 'hold', t0: 8 * 3600 - 60, t1: 8 * 3600, seg: 2, offset: 900, dir: -1, kind: 'layover' },
        { k: 'trip', trip: 'down', pattern: 1 },
        { k: 'hold', t0: arrival('down'), t1: 8 * 3600 + 600, seg: 1, offset: 100, dir: -1, kind: 'layover' },
      ],
    });
  }
  return {
    schema: 1,
    feedVersion: 't',
    services: ['wk'],
    builtAt: '',
    segIds: ['N', 'S', 's'],
    // up: A1 (N@100) → J → B (s@900); down: B → J → A2 (S@100).
    paths: [
      [0, 100, 1000, 2, 0, 900],
      [2, 900, 0, 1, 1000, 100],
    ],
    patterns: { 0: { hops: [0] }, 1: { hops: [1] } },
    runs,
    stats: { trips: runs.length, runs: runs.length, peakInService: {}, unplacedTrips: 0, termini: {} },
  };
}

const strip = (f: MovementsFile) => JSON.stringify({ ...f, dispatch: { ...f.dispatch, ms: 0 } });

describe('dispatch', () => {
  it('leaves a conflict-free plan on its timetable', () => {
    const base = movements(['up']);
    const out = dispatch(base, pp, g, opts);
    expect(out.schema).toBe(2);
    expect(out.runs[0]!.events).toEqual(base.runs[0]!.events);
    expect(out.dispatch!.forced).toHaveLength(0);
  });

  it('holds one train outside the single track while the opposing train uses it', () => {
    const out = dispatch(movements(['up', 'down']), pp, g, opts);
    expect(out.dispatch!.forced).toHaveLength(0);
    const up = out.runs.find((r) => r.id === 'expo-001')!.events.find((e) => e.k === 'trip')!;
    const down = out.runs.find((r) => r.id === 'expo-002')!.events.find((e) => e.k === 'trip')!;
    // Exactly one of them was delayed, waiting at a signal on its approach.
    const delayed = [up, down].filter((e) => e.k === 'trip' && e.times);
    expect(delayed).toHaveLength(1);
    const d = delayed[0]!;
    expect(d.k === 'trip' && d.waits?.[0]?.why).toMatch(/single track|occupied|section|train ahead/);

    // Playback: the two trains never share the single track.
    const pb = new TrainPlayback(out, pp, g, kin, { deadheadSpeedFactor: 0.55, turnbackSpeedFactor: 0.8 });
    let both = 0;
    for (let t = 8 * 3600 - 30; t <= 8 * 3600 + 600; t += 1) {
      const vs = pb.vehiclesAt(t, '20260928');
      const onSingle = vs.filter((v) => v.track?.seg === 's' || (v.track && v.track.offset > 1000 - 34 - 15));
      if (onSingle.length > 1) both++;
    }
    expect(both).toBe(0);
  });

  it('is deterministic', () => {
    expect(strip(dispatch(movements(['up', 'down']), pp, g, opts))).toEqual(strip(dispatch(movements(['up', 'down']), pp, g, opts)));
  });
});
