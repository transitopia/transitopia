import { describe, expect, it } from 'vitest';
import { TrackGraph } from '../src/core/infra/graph.ts';
import type { InfraCollection, InfraFeature, NodeKind, SegmentEnd, SegmentKind } from '../src/core/infra/types.ts';
import type { LonLat } from '../src/core/geo.ts';

// A small synthetic layout (x = metres east, converted to degrees at 49.25°N):
//
//   A ──────── s1 ──────── J ──────── s2 ──────── B (dead end)
//                           \
//                            s3 (diverging branch) ──── C ── p (pocket, dead end)
//
// At switch J, s1 continues onto s2 or s3, but s2 ↔ s3 is not allowed (no reversing through the frog).
const M_PER_DEG_LON = 111_320 * Math.cos((49.25 * Math.PI) / 180);
const pt = (x: number, y = 0): LonLat => [-123 + x / M_PER_DEG_LON, 49.25 + y / 110_574];

function seg(id: string, kind: SegmentKind, from: string, to: string, coords: LonLat[]): InfraFeature {
  let length = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i]![0] - coords[i - 1]![0]) * M_PER_DEG_LON;
    const dy = (coords[i]![1] - coords[i - 1]![1]) * 110_574;
    length += Math.hypot(dx, dy);
  }
  return {
    type: 'Feature',
    properties: { type: 'segment', id, kind, lines: ['expo'], from, to, length, osmWay: 0 },
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
    seg('s1', 'main', 'A', 'J', [pt(0), pt(1000)]),
    seg('s2', 'main', 'J', 'B', [pt(1000), pt(2000)]),
    seg('s3', 'main', 'J', 'C', [pt(1000), pt(1500, -200)]),
    seg('p', 'pocket', 'C', 'P', [pt(1500, -200), pt(1700, -280)]),
    seg('y', 'yard', 'A', 'Y', [pt(0), pt(-300)]),
    node('A', 'switch', pt(0), [['s1:0', 'y:0']]),
    node('J', 'switch', pt(1000), [
      ['s1:1', 's2:0'],
      ['s1:1', 's3:0'],
    ]),
    node('B', 'buffer', pt(2000), []),
    node('C', 'link', pt(1500, -200), [['s3:1', 'p:0']]),
    node('P', 'buffer', pt(1700, -280), []),
    node('Y', 'buffer', pt(-300), []),
  ],
};
const g = TrackGraph.fromCollection(fc);

describe('TrackGraph.route', () => {
  it('routes straight along a segment', () => {
    const r = g.route({ seg: 's1', offset: 100 }, { seg: 's1', offset: 900 })!;
    expect(r.length).toBeCloseTo(800, 0);
    expect(r.startDir).toBe(1);
    expect(r.reversals).toBe(0);
  });
  it('takes either branch of a switch from the trunk', () => {
    expect(g.route({ seg: 's1', offset: 500 }, { seg: 's2', offset: 500 }, { fromDir: 1 })?.length).toBeCloseTo(1000, 0);
    expect(g.route({ seg: 's1', offset: 500 }, { seg: 's3', offset: 100 }, { fromDir: 1 })).not.toBeNull();
  });
  it('never passes branch-to-branch through a switch', () => {
    expect(g.route({ seg: 's2', offset: 500 }, { seg: 's3', offset: 100 }, { allowReversals: false })).toBeNull();
  });
  it('reverses at a dead end only when allowed, counting the reversal', () => {
    // Heading east on s2 towards dead end B, the only way back to s1 is to reverse at B.
    const from = { seg: 's2', offset: 500 };
    const to = { seg: 's1', offset: 500 };
    expect(g.route(from, to, { fromDir: 1, allowReversals: false })).toBeNull();
    const r = g.route(from, to, { fromDir: 1, allowReversals: true })!;
    expect(r.reversals).toBe(1);
    expect(r.endDir).toBe(-1);
    expect(r.length).toBeCloseTo(500 + 1000 + 500, 0);
  });
  it('reverses in a pocket to come back the other way', () => {
    const r = g.route({ seg: 's3', offset: 100 }, { seg: 's1', offset: 500 }, { fromDir: 1, allowReversals: true, reversalRunIn: 100 })!;
    expect(r).not.toBeNull();
    expect(r.reversals).toBe(1);
    expect(r.endDir).toBe(-1);
    expect(r.pieces.some((p) => p.seg === 'p')).toBe(true);
  });
  it('honours the required final direction, optionally reversing at the target', () => {
    const facing = g.route({ seg: 's1', offset: 100 }, { seg: 's1', offset: 900 }, { toDir: -1 });
    expect(facing).toBeNull();
    const rev = g.route({ seg: 's1', offset: 100 }, { seg: 's1', offset: 900 }, { toDir: -1, allowReverseAtTarget: true })!;
    expect(rev.reversals).toBe(1);
    expect(rev.endDir).toBe(-1);
  });
  it('finds the nearest yard with goalKinds', () => {
    const r = g.route({ seg: 's1', offset: 500 }, null, { fromDir: -1, goalKinds: new Set(['yard']) })!;
    expect(r).not.toBeNull();
    expect(r.length).toBeCloseTo(500, 0);
    expect(g.route({ seg: 's2', offset: 500 }, null, { fromDir: 1, goalKinds: new Set(['yard']) })).toBeNull();
  });
  it('applies turn overrides', () => {
    const g2 = TrackGraph.fromCollection(fc);
    g2.setTurn(pt(1000), pt(1500), pt(1250, -100), true);
    expect(g2.route({ seg: 's2', offset: 500 }, { seg: 's3', offset: 100 }, { fromDir: -1 })).not.toBeNull();
    g2.setTurn(pt(1000), pt(500), pt(1500), false);
    expect(g2.route({ seg: 's1', offset: 500 }, { seg: 's2', offset: 500 }, { fromDir: 1 })).toBeNull();
  });
});
