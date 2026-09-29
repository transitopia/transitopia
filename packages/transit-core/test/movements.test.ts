import { describe, expect, it } from 'vitest';
import { TrackGraph } from '../src/infra/graph.ts';
import { buildMovements, splitAtReversals, type OperationsConfig } from '../src/movement/build.ts';
import { TrainPlayback } from '../src/movement/playback.ts';
import { preparePlan } from '../src/schedule/engine.ts';
import type { InfraCollection, InfraFeature, NodeKind, SegmentEnd, SegmentKind } from '../src/infra/types.ts';
import type { PlatformAssignment } from '../src/infra/platforms.ts';
import type { ServicePlan } from '../src/plan/types.ts';
import type { KinematicsConfig } from '../src/movement/kinematics.ts';
import { distM, type LonLat } from '../src/geo.ts';
import { railInputs } from '../src/corrections/reconcile.ts';
import { dispatch, type DispatchConfig } from '../src/dispatch/dispatch.ts';
import type { MovementsFile } from '../src/movement/types.ts';
import type { Observation } from '../src/corrections/types.ts';
import { serviceDayStart } from '../src/time.ts';

// A single line with stub ends and a yard branching off the middle:
//
//   buf ── s1 (A: 0–1000) ── J ── s2 (1000–2000) ── buf
//                             └── y (yard, 300 m)
// Station A at x=100 on s1, station B at x=1900 on s2.
const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [-123 + x / M_PER_DEG_LON, 49.25 + y / 110_574];
function seg(id: string, kind: SegmentKind, from: string, to: string, coords: LonLat[], length: number): InfraFeature {
  return {
    type: 'Feature',
    properties: { type: 'segment', id, kind, lines: kind === 'yard' ? [] : ['expo'], from, to, length, osmWay: 0 },
    geometry: { type: 'LineString', coordinates: coords },
  };
}
function node(id: string, kind: NodeKind, at: LonLat, turns: [SegmentEnd, SegmentEnd][]): InfraFeature {
  return { type: 'Feature', properties: { type: 'node', id, kind, turns, osmNode: 0 }, geometry: { type: 'Point', coordinates: at } };
}
const fc: InfraCollection = {
  type: 'FeatureCollection',
  metadata: { source: 'test', generatedAt: '' },
  features: [
    seg('s1', 'main', 'A0', 'J', [pt(0), pt(1000)], 1000),
    seg('s2', 'main', 'J', 'B0', [pt(1000), pt(2000)], 1000),
    seg('y', 'yard', 'J', 'Y0', [pt(1000), pt(1300, -40)], 303),
    node('A0', 'buffer', pt(0), []),
    node('B0', 'buffer', pt(2000), []),
    node('Y0', 'buffer', pt(1300, -40), []),
    node('J', 'switch', pt(1000), [
      ['s1:1', 's2:0'],
      ['s1:1', 'y:0'],
    ]),
  ],
};
const g = TrackGraph.fromCollection(fc);

const kin: KinematicsConfig = {
  modes: { skytrain: { accel: 1, decel: 1, maxSpeed: 80, minCruiseFraction: 0.6, dwell: 20, length: 68, width: 3, profile: 'trapezoid' } },
  routes: {},
  sizing: { minPixelLength: 14, minPixelWidth: 6 },
};
const ops: OperationsConfig = {
  fleets: { groups: [['expo']] },
  turnback: { minLayoverS: 60, maxLayoverS: 1800, stubMaxLayoverS: 900, maxPullUpM: 100, speedFactor: 0.8, maxTurnbackM: 4000, unloadS: 20, reversalS: 30, blockBonusS: 600 },
  yard: { maxDeadheadM: 10_000, pullOutLeadS: 60, deadheadSpeedFactor: 0.5, runIntoYardM: 100, againstTrafficPenalty: 3 },
};

const plan: ServicePlan = {
  schema: 1,
  feedVersion: 't',
  feedStart: '20260901',
  feedEnd: '20261231',
  timezone: 'America/Vancouver',
  builtAt: '',
  routes: [{ key: 'expo', label: 'Expo', kind: 'skytrain', mode: 'skytrain', color: '#0033a0', textColor: '#fff', gtfsRouteId: '1' }],
  stops: [
    { id: 'A', name: 'A Station @ Platform 1', lon: pt(100)[0], lat: pt(100)[1], platform: '1' },
    { id: 'B', name: 'B Station @ Platform 1', lon: pt(1900)[0], lat: pt(1900)[1], platform: '1' },
  ],
  stations: [],
  shapes: { ab: [pt(100), pt(1900)], ba: [pt(1900), pt(100)] },
  patterns: [
    { id: 0, route: 'expo', direction: 0, shape: 'ab', stops: [0, 1], dist: [0, 1800] },
    { id: 1, route: 'expo', direction: 1, shape: 'ba', stops: [1, 0], dist: [0, 1800] },
  ],
  trips: [
    { id: 't1', pattern: 0, service: 'wk', headsign: 'To B', start: 8 * 3600, arr: [0, 180] },
    { id: 't2', pattern: 1, service: 'wk', headsign: 'To A', start: 8 * 3600 + 360, arr: [0, 180] },
  ],
  calendar: { calendar: [], exceptions: [] },
};
const pp = preparePlan(plan, kin);
const platforms = new Map<string, PlatformAssignment>([
  ['A', { stopId: 'A', name: 'A', pos: { seg: 's1', offset: 100 }, dist: 0, method: 'consistent', agreement: 1 }],
  ['B', { stopId: 'B', name: 'B', pos: { seg: 's2', offset: 900 }, dist: 0, method: 'consistent', agreement: 1 }],
]);

describe('buildMovements + TrainPlayback', () => {
  const file = buildMovements({ graph: g, pp, platforms, services: new Set(['wk']), ops, kin });

  it('chains the two trips into one run with a turnback at B and yard moves at both ends', () => {
    expect(file.stats.trips).toBe(2);
    expect(file.runs).toHaveLength(1);
    const kinds = file.runs[0]!.events.map((e) => (e.k === 'move' ? e.kind : e.k));
    expect(kinds.filter((k) => k === 'trip')).toHaveLength(2);
    expect(kinds[0]).toBe('pullout');
    expect(kinds[kinds.length - 1]).toBe('pullin');
    expect(file.stats.termini.B?.chained ?? Object.values(file.stats.termini)[0]?.chained).toBeGreaterThan(0);
  });

  it('plays back continuously: no jumps, correct stations, reversal at B', () => {
    const pb = new TrainPlayback(file, pp, g, kin, { deadheadSpeedFactor: ops.yard.deadheadSpeedFactor });
    let prev: { lon: number; lat: number } | undefined;
    const seen = new Set<string>();
    for (let t = 7 * 3600 + 3000; t <= 9 * 3600; t += 2) {
      const [v] = pb.vehiclesAt(t, '20260928');
      if (!v) {
        prev = undefined;
        continue;
      }
      seen.add(v.status);
      if (prev) expect(distM([prev.lon, prev.lat], [v.lon, v.lat])).toBeLessThan(2 * 25 + 5);
      prev = v;
    }
    expect(seen).toEqual(new Set(['pullout', 'layover', 'dwell', 'moving', 'pullin']));
    // B is a stub: the train pulls up towards the buffer (≤ 1 train length past the platform point).
    const atB = pb.vehiclesAt(8 * 3600 + 180 + 5, '20260928')[0]!;
    const xAtB = (atB.lon - pt(0)[0]) * M_PER_DEG_LON;
    expect(xAtB).toBeGreaterThan(1890);
    expect(xAtB).toBeLessThan(2000 - 68 / 2);
    const leavingB = pb.vehiclesAt(8 * 3600 + 400, '20260928')[0]!;
    expect(leavingB.bearing).toBeCloseTo(270, 0);
  });

  it('splits paths at reversals', () => {
    const subs = splitAtReversals([
      { seg: 'p', from: 0, to: 100 },
      { seg: 'p', from: 100, to: 20 },
      { seg: 'q', from: 0, to: 50 },
    ]);
    expect(subs).toHaveLength(2);
    expect(subs[1]).toHaveLength(2);
  });
});

describe('corrections (observations → dispatcher → playback)', () => {
  const file = buildMovements({ graph: g, pp, platforms, services: new Set(['wk']), ops, kin });
  const dcfg: DispatchConfig = { stepS: 1, safetyMarginM: 30, foulingM: 15, minHoldS: 40, maxWaitS: 900, crossingBufferS: 30, singleTrackHeadwayS: 720, revenueFirst: true };
  const dopts = { config: dcfg, kin, deadheadSpeedFactor: ops.yard.deadheadSpeedFactor, turnbackSpeedFactor: ops.turnback.speedFactor };
  const base = dispatch(file, pp, g, dopts);
  const date = '20260928';
  const iso = (sec: number) => new Date(serviceDayStart(date) + sec * 1000).toISOString();
  const x = (v: { lon: number }) => (v.lon - pt(0)[0]) * M_PER_DEG_LON;
  const pbOf = (f: MovementsFile) => new TrainPlayback(f, pp, g, kin, { deadheadSpeedFactor: ops.yard.deadheadSpeedFactor, turnbackSpeedFactor: ops.turnback.speedFactor });
  const onPlan = pbOf(base);
  /** The date's plan with observations dispatched, and what couldn't be applied. */
  const corrected = (obs: Observation[]) => {
    const rail = railInputs(file, pp, obs, date);
    return { pb: pbOf(dispatch(file, pp, g, { ...dopts, rail, base })), rail };
  };

  it('delays a trip from a delay report, marks it interpolated, and absorbs the delay at the terminus', () => {
    const { pb } = corrected([{ kind: 'delay', date: '2026-09-28', trip: 't1', seconds: 60, source: 'test' }]);
    const t = 8 * 3600 + 90;
    const late = pb.vehiclesAt(t, date)[0]!;
    expect(x(late)).toBeCloseTo(x(onPlan.vehiclesAt(t - 60, date)[0]!), -1);
    expect(late.provenance).toBe('interpolated');
    expect(late.delay).toBeGreaterThanOrEqual(55);
    // t2 departs 180 s after t1's scheduled arrival: enough slack to absorb 60 s.
    const t2 = pb.vehiclesAt(8 * 3600 + 420, date)[0]!;
    expect(t2.provenance).toBe('estimated');
    expect(x(t2)).toBeCloseTo(x(onPlan.vehiclesAt(8 * 3600 + 420, date)[0]!), 3);
  });

  it('matches an at-platform sighting to the right trip and marks nearby positions observed', () => {
    const t = 8 * 3600 + 180 + 40;
    const { pb, rail } = corrected([{ kind: 'at_platform', date: '2026-09-28', stop: 'B', time: iso(t), source: 'rider', consist: { type: 'Mk III', cars: 4 } }]);
    expect(rail.unmatched).toHaveLength(0);
    const v = pb.vehiclesAt(t, date)[0]!;
    expect(v.provenance).toBe('observed');
    expect(v.consist).toEqual({ type: 'Mk III', cars: 4 });
    expect(v.source).toMatch(/^rider/);
    // The consist sticks to the whole run.
    expect(pb.vehiclesAt(8 * 3600 + 500, date)[0]!.consist?.cars).toBe(4);
  });

  it('hides cancelled trips and reports observations it cannot match', () => {
    const { pb, rail } = corrected([
      { kind: 'cancel', date: '2026-09-28', trip: 't2', source: 'alert' },
      { kind: 'delay', date: '2026-09-28', trip: 'nope', seconds: 30, source: 'x' },
      { kind: 'at_platform', date: '2026-09-28', stop: 'A', time: iso(12 * 3600), source: 'x' },
    ]);
    expect(pb.vehiclesAt(8 * 3600 + 420, date)).toHaveLength(0);
    expect(pb.vehiclesAt(8 * 3600 + 90, date)).toHaveLength(1);
    expect(rail.unmatched.map((u) => u.reason)).toEqual(["trip nope isn't in a train run for this date", 'no scheduled train at that stop near that time']);
  });

  it('does not carry early running past the terminus', () => {
    const { pb } = corrected([{ kind: 'delay', date: '2026-09-28', trip: 't1', seconds: -30, source: 'test' }]);
    const t2 = pb.vehiclesAt(8 * 3600 + 420, date)[0]!;
    expect(t2.provenance).toBe('estimated');
    expect(x(t2)).toBeCloseTo(x(onPlan.vehiclesAt(8 * 3600 + 420, date)[0]!), 3);
  });

  it('shows parked trains around their sighting, observed near the time and inferred otherwise', () => {
    const seen = 9 * 3600;
    const { pb } = corrected([{ kind: 'parked', date: '2026-09-28', at: pt(500), time: iso(seen), source: 'rider', consist: { type: 'Mk I', carNumbers: ['125'] } }]);
    const at = (t: number) => pb.vehiclesAt(t, date).filter((v) => v.headsign.includes('parked'));
    expect(at(seen)[0]!.provenance).toBe('observed');
    expect(at(seen)[0]!.consist?.carNumbers).toEqual(['125']);
    expect(at(seen + 10 * 60)[0]!.provenance).toBe('interpolated');
    expect(at(seen + 20 * 60)).toHaveLength(0);
    expect(Math.abs(x(at(seen)[0]!) - 500)).toBeLessThan(1);
  });

  it('ignores observations for other dates', () => {
    const { rail } = corrected([{ kind: 'cancel', date: '2026-09-29', trip: 't2', source: 'x' }]);
    expect(rail.runs.size).toBe(0);
    expect(rail.used).toBe(0);
  });
});
