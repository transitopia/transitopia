import { describe, expect, it } from 'vitest';
import { busStopLabel, busStopMarkers, busStopTicks } from '../src/core/plan/bus-stops.ts';
import type { ServicePlan } from '../src/core/plan/types.ts';

describe('busStopLabel', () => {
  it('labels street stops by cross street and exchanges by name', () => {
    expect(busStopLabel('Eastbound W Broadway @ Alma St')).toBe('Alma St');
    expect(busStopLabel('Eastbound E Broadway  @ Fraser St')).toBe('Fraser St');
    expect(busStopLabel('Hastings St @ Willingdon Ave-')).toBe('Willingdon Ave');
    expect(busStopLabel('UBC Exchange @ Bay 7')).toBe('UBC Exchange');
    expect(busStopLabel('UBC Exchange @ Unloading Only')).toBe('UBC Exchange');
    expect(busStopLabel('Phibbs Exchange @')).toBe('Phibbs Exchange');
  });
  it('drops station bays and layovers', () => {
    expect(busStopLabel('Commercial-Broadway Station @ Bay 5')).toBeUndefined();
    expect(busStopLabel('Newton Exchange @ Layover')).toBeUndefined();
  });
});

describe('busStopMarkers', () => {
  const plan = {
    routes: [
      { key: '99', kind: 'bus' },
      { key: 'expo', kind: 'skytrain' },
    ],
    stops: [
      { id: 'a', name: 'Eastbound W Broadway @ Alma St', lon: -123.1846, lat: 49.2643 },
      { id: 'b', name: 'Westbound W Broadway @ Alma St', lon: -123.1858, lat: 49.2645 },
      { id: 'c', name: 'Eastbound E Broadway @ Rupert St', lon: -123.0328, lat: 49.2615 },
      { id: 'd', name: 'Rupert Station @ Platform 1', lon: -123.0328, lat: 49.2606 },
    ],
    stations: [{ id: 's', name: 'Rupert', lon: -123.0328, lat: 49.2606, routes: ['expo'] }],
    // Broadway runs east–west along lat 49.2644; the eastbound stop is on the south curb, westbound north.
    shapes: {
      east: [[-123.19, 49.2644], [-123.03, 49.2644]],
      west: [[-123.03, 49.2644], [-123.19, 49.2644]],
    },
    patterns: [
      { id: 0, route: '99', shape: 'east', stops: [0, 2], dist: [393, 11_500] },
      { id: 1, route: '99', shape: 'west', stops: [2, 1], dist: [0, 11_070] },
      { id: 2, route: 'expo', shape: 'east', stops: [3], dist: [0] },
    ],
    trips: [{ pattern: 0 }, { pattern: 1 }, { pattern: 2 }],
  } as unknown as ServicePlan;

  it('merges both directions into one marker and skips stops at stations', () => {
    const m = busStopMarkers(plan);
    expect(m.map((x) => x.name)).toEqual(['Alma St']);
    expect(m[0]!.routes).toEqual(['99']);
  });

  it('points each tick toward the side of the street its stop is on', () => {
    const t = busStopTicks(plan);
    expect(t).toHaveLength(2);
    expect(t.map((x) => Math.round(x.bearing)).sort((a, b) => a - b)).toEqual([0, 180]);
    for (const x of t) expect(x.lat).toBeCloseTo(49.2644, 6);
  });
});
