import { describe, expect, it } from 'vitest';
import { applyFerryBerths, berthPath, type FerryConfig, type FerryInfra } from '../src/core/plan/ferry-berths.ts';
import { bearingDeg, distM } from '../src/core/geo.ts';
import type { PlanTrip, ServicePlan } from '../src/core/plan/types.ts';

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
const cfg: FerryConfig = { pairs: [{ south: 'west', north: 'west' }, { south: 'east', north: 'east' }] };

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
  it('keeps other patterns in place and gives each vessel one berth pair all day', () => {
    const trips = [...shuttle('a', 21600, 8), ...shuttle('b', 22500, 8), { id: 'bus1', pattern: 0, service: 'wk', headsign: '', start: 0, arr: [0, 600] }];
    const plan = makePlan(trips);
    const report = applyFerryBerths(plan, infra, cfg);
    expect(plan.patterns[0]!.shape).toBe('bus');
    expect(plan.patterns).toHaveLength(5);
    expect(plan.shapes.gn).toBeUndefined();
    const pairOf = (t: PlanTrip) => plan.patterns[t.pattern]!.shape.includes('-west') ? 'west' : 'east';
    const a = new Set(plan.trips.filter((t) => t.block === 'a').map(pairOf));
    const b = new Set(plan.trips.filter((t) => t.block === 'b').map(pairOf));
    expect([...a]).toEqual(['west']);
    expect([...b]).toEqual(['east']);
    expect(report.vessels.get('wk')).toEqual([1, 1]);
    expect(report.sharedBerthS).toBe(0);
    // Each pattern ends at its berths.
    for (const t of plan.trips.filter((x) => x.block)) {
      const p = plan.patterns[t.pattern]!;
      const coords = plan.shapes[p.shape]!;
      const [from, to] = p.direction === 0 ? ['south', 'north'] : ['north', 'south'];
      expect(coords[0]).toEqual(infra.terminals[from]!.berths[pairOf(t)]!.dock);
      expect(coords[coords.length - 1]).toEqual(infra.terminals[to]!.berths[pairOf(t)]!.dock);
      expect(p.dist[1]).toBeGreaterThan(2200);
    }
  });
});
