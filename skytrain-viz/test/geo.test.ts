import { describe, expect, it } from 'vitest';
import { cumulativeLengths, distM, pointAlong, projectOnto, simplify, type LonLat } from '../src/core/geo.ts';
import { interpolateMissing } from '../scripts/build-schedule.ts';

// A 2 km east–west line at Vancouver's latitude.
const line: LonLat[] = [
  [-123.1, 49.25],
  [-123.086, 49.25],
  [-123.0725, 49.25],
];

describe('geo', () => {
  it('measures distances plausibly', () => {
    const d = distM(line[0]!, line[2]!);
    expect(d).toBeGreaterThan(1990);
    expect(d).toBeLessThan(2010);
  });
  it('interpolates points along a polyline', () => {
    const cum = cumulativeLengths(line);
    const mid = pointAlong(line, cum, cum[2]! / 2);
    expect(mid.lat).toBeCloseTo(49.25, 6);
    expect(mid.bearing).toBeCloseTo(90, 0);
    expect(pointAlong(line, cum, -5).lon).toBe(line[0]![0]);
    expect(pointAlong(line, cum, 1e9).lon).toBe(line[2]![0]);
  });
  it('projects points onto the line, searching forward', () => {
    const cum = cumulativeLengths(line);
    const p = projectOnto(line, cum, [-123.086, 49.2503]);
    expect(p.offset).toBeGreaterThan(30);
    expect(p.offset).toBeLessThan(36);
    expect(p.along).toBeCloseTo(cum[1]!, -1);
  });
  it('does not snap to an earlier pass on out-and-back shapes', () => {
    const outBack: LonLat[] = [...line, [-123.086, 49.2501], [-123.1, 49.2501]];
    const cum = cumulativeLengths(outBack);
    const p = projectOnto(outBack, cum, [-123.093, 49.25005], cum[2]!);
    expect(p.along).toBeGreaterThan(cum[2]!);
  });
  it('simplifies collinear points away', () => {
    expect(simplify(line, 1)).toHaveLength(2);
  });
});

describe('interpolateMissing', () => {
  it('fills blank times by distance', () => {
    expect(interpolateMissing([0, NaN, NaN, 300], [0, 100, 200, 300])).toEqual([0, 100, 200, 300]);
  });
  it('throws when the endpoints are blank', () => {
    expect(() => interpolateMissing([NaN, 10], [0, 1])).toThrow();
  });
});

describe('routeSections', () => {
  it('marks sections served by few trips as limited', async () => {
    const { routeSections } = await import('../src/core/plan/coverage.ts');
    const plan = {
      shapes: {
        main: [[-123.1, 49.25], [-123.08, 49.25]],
        ext: [[-123.1, 49.25], [-123.08, 49.25], [-123.06, 49.25]],
      },
      patterns: [
        { id: 0, route: '99', direction: 0, shape: 'main', stops: [], dist: [] },
        { id: 1, route: '99', direction: 0, shape: 'ext', stops: [], dist: [] },
      ],
      trips: [...Array.from({ length: 40 }, () => ({ pattern: 0 })), ...Array.from({ length: 5 }, () => ({ pattern: 1 }))],
    } as unknown as Parameters<typeof routeSections>[0];
    const secs = routeSections(plan, new Set(['99']));
    const ext = secs.filter((s) => s.limited);
    expect(ext.length).toBeGreaterThan(0);
    // The limited part is the extension east of -123.08.
    for (const s of ext) for (const [lon] of s.coords) expect(lon).toBeGreaterThan(-123.0815);
    expect(secs.some((s) => !s.limited)).toBe(true);
  });
});
