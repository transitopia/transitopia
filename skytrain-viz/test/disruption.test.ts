import { describe, expect, it } from 'vitest';
import { TrackGraph } from '../src/core/infra/graph.ts';
import { applyDisruptions } from '../src/core/disruption/apply.ts';
import type { Disruption } from '../src/core/disruption/types.ts';
import { buildMovements, type OperationsConfig } from '../src/core/movement/build.ts';
import { dispatch, type DispatchConfig } from '../src/core/dispatch/dispatch.ts';
import { TrainPlayback } from '../src/core/movement/playback.ts';
import { preparePlan } from '../src/core/schedule/engine.ts';
import type { InfraCollection, InfraFeature, NodeKind, SegmentEnd, SegmentKind } from '../src/core/infra/types.ts';
import type { PlatformAssignment } from '../src/core/infra/platforms.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';
import type { KinematicsConfig } from '../src/core/movement/kinematics.ts';
import type { LonLat } from '../src/core/geo.ts';

// Double track A–M–B: U runs +x (A1, M1, B1), D runs −x (B2, M2, A2). Crossovers let −x trains move
// from D to U before M (X2) and back to D after it (X1).
//
//   U0 ── Ju1 ─────── U1 (M1) ─────── Ju2 ── U2
//          ╲X1                     X2╱
//   D0 ── Jd1 ─────── D1 (M2) ─────── Jd2 ── D2
const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [-123 + x / M_PER_DEG_LON, 49.25 + y / 110_574];
function seg(id: string, kind: SegmentKind, from: string, to: string, a: LonLat, b: LonLat, length: number): InfraFeature {
  return { type: 'Feature', properties: { type: 'segment', id, kind, lines: ['canada'], from, to, length, osmWay: 0 }, geometry: { type: 'LineString', coordinates: [a, b] } };
}
function node(id: string, kind: NodeKind, at: LonLat, turns: [SegmentEnd, SegmentEnd][]): InfraFeature {
  return { type: 'Feature', properties: { type: 'node', id, kind, turns, osmNode: 0 }, geometry: { type: 'Point', coordinates: at } };
}
const U = 4;
const D = -4;
const fc: InfraCollection = {
  type: 'FeatureCollection',
  metadata: { source: 'test', generatedAt: '' },
  features: [
    seg('U0', 'main', 'Ua', 'Ju1', pt(0, U), pt(300, U), 300),
    seg('U1', 'main', 'Ju1', 'Ju2', pt(300, U), pt(1750, U), 1450),
    seg('U2', 'main', 'Ju2', 'Ub', pt(1750, U), pt(2000, U), 250),
    seg('D0', 'main', 'Da', 'Jd1', pt(0, D), pt(200, D), 200),
    seg('D1', 'main', 'Jd1', 'Jd2', pt(200, D), pt(1850, D), 1650),
    seg('D2', 'main', 'Jd2', 'Db', pt(1850, D), pt(2000, D), 150),
    seg('X1', 'crossover', 'Jd1', 'Ju1', pt(200, D), pt(300, U), 100),
    seg('X2', 'crossover', 'Ju2', 'Jd2', pt(1750, U), pt(1850, D), 100),
    node('Ua', 'buffer', pt(0, U), []),
    node('Ub', 'buffer', pt(2000, U), []),
    node('Da', 'buffer', pt(0, D), []),
    node('Db', 'buffer', pt(2000, D), []),
    node('Ju1', 'switch', pt(300, U), [
      ['U0:1', 'U1:0'],
      ['U1:0', 'X1:1'],
    ]),
    node('Jd1', 'switch', pt(200, D), [
      ['D0:1', 'D1:0'],
      ['X1:0', 'D0:1'],
    ]),
    node('Ju2', 'switch', pt(1750, U), [
      ['U1:1', 'U2:0'],
      ['X2:0', 'U1:1'],
    ]),
    node('Jd2', 'switch', pt(1850, D), [
      ['D1:1', 'D2:0'],
      ['D2:0', 'X2:1'],
    ]),
  ],
};
const g = TrackGraph.fromCollection(fc);

const kin: KinematicsConfig = {
  modes: { skytrain: { accel: 1, decel: 1.3, maxSpeed: 80, minCruiseFraction: 0.6, dwell: 20, length: 41, width: 3, profile: 'trapezoid' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};
const ops: OperationsConfig = {
  fleets: { groups: [['canada']] },
  turnback: { minLayoverS: 60, maxLayoverS: 1800, stubMaxLayoverS: 900, maxPullUpM: 100, speedFactor: 0.8, maxTurnbackM: 4000, unloadS: 20, reversalS: 30, blockBonusS: 600 },
  yard: { maxDeadheadM: 10_000, pullOutLeadS: 60, deadheadSpeedFactor: 0.5, runIntoYardM: 100, againstTrafficPenalty: 3 },
};
const config: DispatchConfig = { stepS: 1, safetyMarginM: 30, foulingM: 15, minHoldS: 40, maxWaitS: 900, crossingBufferS: 30, singleTrackHeadwayS: 720, revenueFirst: true };

const stop = (id: string, station: string, x: number, y: number) => ({ id, name: `${station} Station @ Platform ${id.slice(-1)}`, parent: station, lon: pt(x, y)[0], lat: pt(x, y)[1], platform: id.slice(-1) });
const plan = {
  schema: 1,
  feedVersion: 't',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'canada', label: 'Canada', kind: 'skytrain', mode: 'skytrain', color: '#009ac7', textColor: '#fff', gtfsRouteId: '1' }],
  stops: [stop('A1', 'A', 100, U), stop('A2', 'A', 100, D), stop('M1', 'M', 1000, U), stop('M2', 'M', 1000, D), stop('B1', 'B', 1900, U), stop('B2', 'B', 1900, D)],
  stations: ['A', 'M', 'B'].map((s, i) => ({ id: s, name: s, lon: pt(100 + i * 900)[0], lat: pt(100 + i * 900)[1] })),
  shapes: { up: [pt(100), pt(1900)], down: [pt(1900), pt(100)] },
  patterns: [
    { id: 0, route: 'canada', direction: 0, shape: 'up', stops: [0, 2, 4], dist: [0, 900, 1800] },
    { id: 1, route: 'canada', direction: 1, shape: 'down', stops: [5, 3, 1], dist: [0, 900, 1800] },
  ],
  trips: [
    { id: 'down-noon', pattern: 1, service: 'wk', headsign: 'To A', start: 12 * 3600, arr: [0, 120, 240] },
    { id: 'up-22', pattern: 0, service: 'wk', headsign: 'To B', start: 22 * 3600, arr: [0, 120, 240] },
    { id: 'down-22', pattern: 1, service: 'wk', headsign: 'To A', start: 22 * 3600, arr: [0, 120, 240] },
  ],
  calendar: { calendar: [], exceptions: [] },
} as unknown as ServicePlan;
const assign = (id: string, seg: string, offset: number): [string, PlatformAssignment] => [id, { stopId: id, name: id, pos: { seg, offset }, dist: 0, method: 'consistent', agreement: 1 }];
const platforms = new Map([assign('A1', 'U0', 100), assign('A2', 'D0', 100), assign('M1', 'U1', 700), assign('M2', 'D1', 800), assign('B1', 'U2', 150), assign('B2', 'D2', 50)]);

const disruption: Disruption = {
  id: 'test',
  source: 'test alert',
  text: 'Single-tracking between A and B',
  active: [{ from: '2026-09-28T21:30:00-07:00', until: '2026-09-28T23:30:00-07:00' }],
  singleTrack: [{ line: 'canada', between: ['A', 'B'], keep: 'M1' }],
};
const services = new Set(['wk']);
const day = applyDisruptions({ plan, graph: g, platforms, services, date: '20260928', disruptions: [disruption] });

describe('disruptions', () => {
  it('moves the section onto the open track and closes the other one between the stations', () => {
    expect(day.problems).toEqual([]);
    expect([...day.closures[0]!.segs]).toEqual(['D1']);
    // Both patterns serve the section and route with the closure; the −x one is pinned to U.
    const clone = day.plan.patterns.slice(2).find((p) => p.direction === 1)!;
    expect(clone.stops).toEqual(plan.patterns[1]!.stops);
    expect(day.patternPositions.get(clone.id)?.get(1)).toEqual({ seg: 'U1', offset: 700 });
    expect(day.plan.trips.find((t) => t.id === 'down-22')!.pattern).toBe(clone.id);
    expect(day.plan.trips.find((t) => t.id === 'down-noon')!.pattern).toBe(1);
    expect(day.notices[0]!.text).toBe('Single-tracking between A and B');
  });

  it('routes trips in the period around the closed track, and others as normal', () => {
    const pp = preparePlan(day.plan, kin);
    const file = buildMovements({ graph: g, pp, platforms, patternPositions: day.patternPositions, services, ops, kin, closures: day.closures });
    const segsOf = (trip: string) => {
      const e = file.runs.flatMap((r) => r.events).find((x) => x.k === 'trip' && x.trip === trip);
      if (e?.k !== 'trip') throw new Error(trip);
      return file.patterns[e.pattern]!.hops.flatMap((h) => file.paths[h]!.filter((_, i) => i % 3 === 0).map((si) => file.segIds[si]));
    };
    expect(segsOf('down-22')).toEqual(expect.arrayContaining(['X2', 'U1', 'X1']));
    expect(segsOf('down-22')).not.toContain('D1');
    expect(segsOf('down-noon')).toContain('D1');
  });

  it('runs the open track as single track: opposing trains never share it', () => {
    const pp = preparePlan(day.plan, kin);
    const file = buildMovements({ graph: g, pp, platforms, patternPositions: day.patternPositions, services, ops, kin, closures: day.closures });
    const out = dispatch(file, pp, g, { config, kin, deadheadSpeedFactor: 0.5, turnbackSpeedFactor: 0.8 });
    expect(out.dispatch!.forced).toHaveLength(0);
    const pb = new TrainPlayback(out, pp, g, kin, { deadheadSpeedFactor: 0.5, turnbackSpeedFactor: 0.8 });
    let shared = 0;
    for (let t = 22 * 3600 - 60; t <= 22 * 3600 + 900; t++) {
      const onU1 = pb.vehiclesAt(t, '20260928').filter((v) => v.track?.seg === 'U1' && v.tripId);
      if (onU1.length > 1 && new Set(onU1.map((v) => v.tripId)).size > 1) shared++;
    }
    expect(shared).toBe(0);
  });
});
