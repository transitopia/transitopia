import { describe, expect, it } from 'vitest';
import { mergeCorrections } from '../src/app/plans.ts';
import type { ScheduleCorrections } from '../src/core/schedule/engine.ts';

describe('mergeCorrections', () => {
  it('keeps a ferry berth-pair shape override from either side', () => {
    const seabus: ScheduleCorrections = { trips: new Map([['a', { anchors: [], observed: [] }]]), cancelled: new Set(), consists: new Map(), shapes: new Map([[61, 'east']]) };
    const buses: ScheduleCorrections = { trips: new Map([['b', { anchors: [], observed: [] }]]), cancelled: new Set(), consists: new Map() };
    const m = mergeCorrections(seabus, buses)!;
    expect([...m.trips.keys()].sort()).toEqual(['a', 'b']);
    expect(m.shapes).toBe(seabus.shapes);
    expect(mergeCorrections(buses, seabus)!.shapes).toBe(seabus.shapes);
    // Cached: the engine's per-object caches depend on getting the same object back.
    expect(mergeCorrections(seabus, buses)).toBe(m);
  });
});
