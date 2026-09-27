import { describe, expect, it } from 'vitest';
import { busStopLabel, busStopMarkers } from '../src/core/plan/bus-stops.ts';
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
    patterns: [
      { id: 0, route: '99', stops: [0, 2] },
      { id: 1, route: '99', stops: [2, 1] },
      { id: 2, route: 'expo', stops: [3] },
    ],
    trips: [{ pattern: 0 }, { pattern: 1 }, { pattern: 2 }],
  } as unknown as ServicePlan;

  it('merges both directions into one marker and skips stops at stations', () => {
    const m = busStopMarkers(plan);
    expect(m.map((x) => x.name)).toEqual(['Alma St']);
    expect(m[0]!.routes).toEqual(['99']);
    expect(m[0]!.lon).toBeCloseTo(-123.1852, 4);
  });
});
