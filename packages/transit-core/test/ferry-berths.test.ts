import { describe, expect, it } from 'vitest';
import { applyFerryBerths, berthPath, type FerryConfig, type FerryInfra } from '../src/plan/ferry-berths.ts';
import { bearingDeg, distM } from '../src/geo.ts';
import type { PlanTrip, ServicePlan } from '../src/plan/types.ts';

// Two terminals ~2.2 km apart north–south, each with a west and an east berth 30 m apart.
const infra: FerryInfra = {
  route: 'ferry',
  approachM: 50,
  terminals: {
    south: { berths: { west: { dock: [-123.1002, 49.28], outBearing: 0 }, east: { dock: [-123.0998, 49.28], outBearing: 0 } } },
    north: { berths: { west: { dock: [-123.1002, 49.3], outBearing: 180 }, east: { dock: [-123.0998, 49.3], outBearing: 180 } } },
  },
  lanes: {
    'south>north': [[-123.098, 49.285], [-123.097, 49.29], [-123.098, 49.295]],
    'north>south': [[-123.102, 49.295], [-123.103, 49.29], [-123.102, 49.285]],
  },
};
const cfg: FerryConfig = { defaultPair: 'west' };

function makePlan(trips: PlanTrip[]): ServicePlan {
  return {
    schema: 1,
    feedVersion: 'test',
    feedStart: '20260901',
    feedEnd: '20261231',
    timezone: 'America/Vancouver',
    builtAt: '',
    routes: [
      { key: 'bus', label: 'Bus', kind: 'bus', mode: 'bus', color: '#000', textColor: '#fff', gtfsRouteId: '1' },
      { key: 'ferry', label: 'Ferry', kind: 'shape', mode: 'ferry', color: '#000', textColor: '#fff', gtfsRouteId: '2' },
    ],
    stops: [
      { id: 'S', name: 'South', lon: -123.1, lat: 49.2799 },
      { id: 'N', name: 'North', lon: -123.1, lat: 49.3001 },
    ],
    stations: [],
    shapes: { bus: [[-123.2, 49.2], [-123.1, 49.2]], gn: [[-123.1, 49.28], [-123.1, 49.3]], gs: [[-123.1, 49.3], [-123.1, 49.28]] },
    patterns: [
      { id: 0, route: 'bus', direction: 0, shape: 'bus', stops: [0, 1], dist: [0, 7000] },
      { id: 1, route: 'ferry', direction: 0, shape: 'gn', stops: [0, 1], dist: [0, 2200] },
      { id: 2, route: 'ferry', direction: 1, shape: 'gs', stops: [1, 0], dist: [0, 2200] },
    ],
    trips,
    calendar: { calendar: [], exceptions: [] },
  };
}

/** A vessel shuttling every 30 min: north at :00, south at :15, 12-minute crossings. */
function shuttle(block: string, first: number, n: number): PlanTrip[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${block}-${i}`,
    pattern: i % 2 === 0 ? 1 : 2,
    service: 'wk',
    block,
    headsign: '',
    start: first + i * 900,
    arr: [0, 720],
  }));
}

describe('berthPath', () => {
  it('runs dock to dock, leaving and entering each slip along its axis, through the lane', () => {
    const p = berthPath(infra, 'south', 'west', 'north', 'west');
    expect(p[0]).toEqual(infra.terminals.south!.berths.west!.dock);
    expect(p[p.length - 1]).toEqual(infra.terminals.north!.berths.west!.dock);
    expect(bearingDeg(p[0]!, p[1]!)).toBeLessThan(20);
    // Keeps right: northbound passes east of the direct line.
    const mid = p[Math.floor(p.length / 2)]!;
    expect(mid[0]).toBeGreaterThan(-123.099);
    expect(distM(mid, [-123.097, 49.29])).toBeLessThan(200);
  });
});

describe('applyFerryBerths', () => {
  it('runs every vessel between the configured berths, keeping pattern ids', () => {
    const trips = [...shuttle('a', 21600, 8), ...shuttle('b', 22500, 8), { id: 'bus1', pattern: 0, service: 'wk', headsign: '', start: 0, arr: [0, 600] }];
    const plan = makePlan(trips);
    const report = applyFerryBerths(plan, infra, cfg);
    expect(plan.patterns.map((p) => p.id)).toEqual([0, 1, 2]);
    expect(plan.patterns[0]!.shape).toBe('bus');
    expect(plan.shapes.gn).toBeUndefined();
    for (const [pi, from, to] of [[1, 'south', 'north'], [2, 'north', 'south']] as const) {
      const p = plan.patterns[pi]!;
      const coords = plan.shapes[p.shape]!;
      expect(coords[0]).toEqual(infra.terminals[from]!.berths.west!.dock);
      expect(coords[coords.length - 1]).toEqual(infra.terminals[to]!.berths.west!.dock);
      expect(p.dist[1]).toBeGreaterThan(2200);
    }
    // Both pairs' shapes are listed; trips use the default pair's.
    expect(Object.keys(plan.ferry!.pairs).sort()).toEqual(['east', 'west']);
    expect(plan.ferry!.pairs.west!.shapes[1]).toBe(plan.patterns[1]!.shape);
    const east = plan.shapes[plan.ferry!.pairs.east!.shapes[1]!]!;
    expect(east[0]).toEqual(infra.terminals.south!.berths.east!.dock);
    expect(plan.ferry!.pairs.east!.docks).toEqual([infra.terminals.south!.berths.east!.dock, infra.terminals.north!.berths.east!.dock]);
    // a docks at :12–:15 and b at :27–:30 of each half hour: the shared berth is free 12 min between them.
    expect(report.sharedBerthS).toBe(0);
    expect(report.minBerthGapS).toBe(720);
  });

  it('reports vessels docked at the same berth at once', () => {
    const plan = makePlan([...shuttle('a', 21600, 4), ...shuttle('b', 21660, 4)]);
    expect(applyFerryBerths(plan, infra, cfg).sharedBerthS).toBeGreaterThan(0);
  });
});
