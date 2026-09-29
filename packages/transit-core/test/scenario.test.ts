import { describe, expect, it } from 'vitest';
import { TrackGraph } from '../src/infra/graph.ts';
import { composeNetwork } from '../src/scenario/network.ts';
import { applyService } from '../src/scenario/service.ts';
import type { InfraCollection, InfraFeature, NodeKind, SegmentEnd } from '../src/infra/types.ts';
import type { ServicePlan } from '../src/plan/types.ts';
import type { KinematicsConfig } from '../src/movement/kinematics.ts';
import type { LonLat } from '../src/geo.ts';

const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [Math.round((-123 + x / M_PER_DEG_LON) * 1e7) / 1e7, Math.round((49.25 + y / 110_574) * 1e7) / 1e7];
const node = (id: string, kind: NodeKind, at: LonLat, turns: [SegmentEnd, SegmentEnd][] = []): InfraFeature => ({
  type: 'Feature',
  properties: { type: 'node', id, kind, turns, osmNode: 0 },
  geometry: { type: 'Point', coordinates: at },
});
// Base: one 1 km track ending at a buffer.
const base: InfraCollection = {
  type: 'FeatureCollection',
  metadata: { source: 'test', generatedAt: '' },
  features: [
    {
      type: 'Feature',
      properties: { type: 'segment', id: 's', kind: 'main', lines: ['millennium'], from: 'a', to: 'b', length: 1000, osmWay: 7 },
      geometry: { type: 'LineString', coordinates: [pt(0), pt(500), pt(1000)] },
    },
    node('a', 'buffer', pt(0)),
    node('b', 'buffer', pt(1000)),
  ],
};

describe('composeNetwork', () => {
  it('joins custom track at an existing buffer and lets trains run through', () => {
    const custom: GeoJSON.FeatureCollection<GeoJSON.LineString, { kind?: 'main'; lines?: ['millennium'] }> = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { lines: ['millennium'] }, geometry: { type: 'LineString', coordinates: [pt(1001), pt(2000)] } }],
    };
    const { fc, stats } = composeNetwork({ base, custom });
    expect(stats.customTracks).toBe(1);
    const g = TrackGraph.fromCollection(fc);
    const start = g.nearest(pt(100), 5)[0]!;
    const end = g.nearest(pt(1900), 5)[0]!;
    const r = g.route(start, end, { allowReversals: false });
    expect(r).not.toBeNull();
    expect(r!.length).toBeCloseTo(1800, -1);
  });
  it('can remove base ways', () => {
    const { fc } = composeNetwork({ base, removeWays: [7] });
    expect(fc.features.filter((f) => f.properties.type === 'segment')).toHaveLength(0);
  });
});

describe('applyService extend', () => {
  const kin: KinematicsConfig = {
    modes: { skytrain: { accel: 1, decel: 1, maxSpeed: 80, minCruiseFraction: 0.6, dwell: 20, length: 68, width: 3, profile: 'trapezoid' } },
    routes: {},
    sizing: { minPixelLength: 14, minPixelWidth: 6 },
  };
  const plan: ServicePlan = {
    schema: 1,
    feedVersion: 'v',
    feedStart: '20260901',
    feedEnd: '20261231',
    timezone: 'America/Vancouver',
    builtAt: '',
    routes: [{ key: 'millennium', label: 'M', kind: 'skytrain', mode: 'skytrain', color: '#ffcd00', textColor: '#000', gtfsRouteId: '1' }],
    stops: [
      { id: 'x1', name: 'X Station @ Platform 1', lon: pt(0)[0], lat: pt(0)[1], parent: 'X', platform: '1' },
      { id: 'y1', name: 'Y Station @ Platform 1', lon: pt(1000)[0], lat: pt(1000)[1], parent: 'Y', platform: '1' },
      { id: 'y2', name: 'Y Station @ Platform 2', lon: pt(1000)[0], lat: pt(1000)[1], parent: 'Y', platform: '2' },
      { id: 'x2', name: 'X Station @ Platform 2', lon: pt(0)[0], lat: pt(0)[1], parent: 'X', platform: '2' },
    ],
    stations: [
      { id: 'X', name: 'X', lon: pt(0)[0], lat: pt(0)[1], routes: ['millennium'] },
      { id: 'Y', name: 'Y', lon: pt(1000)[0], lat: pt(1000)[1], routes: ['millennium'] },
    ],
    shapes: { out: [pt(0), pt(1000)], in: [pt(1000), pt(0)] },
    patterns: [
      { id: 0, route: 'millennium', direction: 0, shape: 'out', stops: [0, 1], dist: [0, 1000] },
      { id: 1, route: 'millennium', direction: 1, shape: 'in', stops: [2, 3], dist: [0, 1000] },
    ],
    trips: [
      { id: 'o', pattern: 0, service: 's', headsign: 'Millennium Line To Y', start: 36000, arr: [0, 90] },
      { id: 'i', pattern: 1, service: 's', headsign: 'Millennium Line To X', start: 36300, arr: [0, 90] },
    ],
    calendar: { calendar: [], exceptions: [] },
  };
  const out = applyService(plan, [{ op: 'extend', route: 'millennium', at: 'Y', stations: [{ name: 'Z', at: pt(2000) }] }], kin, 'test');

  it('appends new stations to trips ending at the terminus, with plausible times', () => {
    const o = out.trips.find((t) => t.id === 'o')!;
    const p = out.patterns[o.pattern]!;
    expect(p.stops.map((si) => out.stops[si]!.name)).toEqual(['X Station @ Platform 1', 'Y Station @ Platform 1', 'Z Station @ Platform 1']);
    expect(o.start).toBe(36000);
    expect(o.arr[2]! - o.arr[1]!).toBeGreaterThan(60);
    expect(o.headsign).toBe('Millennium Line To Z');
  });
  it('starts trips that started at the terminus from the new end, keeping their original timing', () => {
    const i = out.trips.find((t) => t.id === 'i')!;
    const p = out.patterns[i.pattern]!;
    expect(out.stops[p.stops[0]!]!.name).toBe('Z Station @ Platform 2');
    expect(i.start).toBeLessThan(36300);
    // The original departure from Y is unchanged.
    expect(i.start + i.arr[1]!).toBeGreaterThanOrEqual(36300);
    expect(out.feedVersion).toBe('v~test');
    expect(plan.trips[0]!.pattern).toBe(0); // base plan untouched
  });
});

describe('applyService truncate', () => {
  // A bus route from W (x=0) to E (x=3000) with stops every 1 km, both directions.
  const stop = (id: string, x: number) => ({ id, name: `Stop ${id}`, lon: pt(x)[0], lat: pt(x)[1] });
  const plan: ServicePlan = {
    schema: 1,
    feedVersion: 'v',
    feedStart: '20260901',
    feedEnd: '20261231',
    timezone: 'America/Vancouver',
    builtAt: '',
    routes: [{ key: '99', label: '99', kind: 'bus', mode: 'bus', color: '#f76707', textColor: '#fff', gtfsRouteId: '1' }],
    stops: [stop('a', 0), stop('b', 1000), stop('c', 2000), stop('d', 3000), stop('e', 2500)],
    stations: [],
    shapes: { ew: [pt(0), pt(3000)], we: [pt(3000), pt(0)], east: [pt(2500), pt(3000)] },
    patterns: [
      { id: 0, route: '99', direction: 0, shape: 'ew', stops: [0, 1, 2, 3], dist: [0, 1000, 2000, 3000] },
      { id: 1, route: '99', direction: 1, shape: 'we', stops: [3, 2, 1, 0], dist: [0, 1000, 2000, 3000] },
      { id: 2, route: '99', direction: 0, shape: 'east', stops: [4, 3], dist: [0, 500] },
    ],
    trips: [
      { id: 'out', pattern: 0, service: 's', headsign: '99/To D', start: 1000, arr: [0, 100, 200, 300] },
      { id: 'back', pattern: 1, service: 's', headsign: '99/To A', start: 2000, arr: [0, 100, 200, 300] },
      { id: 'short', pattern: 2, service: 's', headsign: '99/To D', start: 3000, arr: [0, 60] },
    ],
    calendar: { calendar: [], exceptions: [] },
  };
  const out = applyService(plan, [{ op: 'truncate', route: '99', at: pt(1000), keep: pt(0), terminusName: 'B Station' }], {} as KinematicsConfig, 't');
  const names = (id: string) => {
    const t = out.trips.find((x) => x.id === id)!;
    return out.patterns[t.pattern]!.stops.map((si) => out.stops[si]!.id);
  };
  it('cuts outbound trips at the cut stop and renames their destination', () => {
    expect(names('out')).toEqual(['a', 'b']);
    const t = out.trips.find((x) => x.id === 'out')!;
    expect(t.start).toBe(1000);
    expect(t.arr).toEqual([0, 100]);
    expect(t.headsign).toBe('99/To B Station');
  });
  it('starts inbound trips at the cut stop, keeping timetabled times', () => {
    expect(names('back')).toEqual(['b', 'a']);
    const t = out.trips.find((x) => x.id === 'back')!;
    expect(t.start).toBe(2200);
    expect(t.arr).toEqual([0, 100]);
    expect(t.headsign).toBe('99/To A');
  });
  it('drops trips entirely beyond the cut', () => {
    expect(out.trips.find((x) => x.id === 'short')).toBeUndefined();
  });
});
