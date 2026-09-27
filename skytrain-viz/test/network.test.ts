import { describe, expect, it } from 'vitest';
import { buildNetwork, type OsmNode, type OsmWay } from '../src/core/infra/network.ts';

// The flat double crossover north of Broadway-City Hall (OSM geometry): the diagonals meet at ~16°.
const pts: Record<number, [number, number]> = {
  1: [-123.1147, 49.2650], // track A, north
  2: [-123.114719, 49.2637613], // A switch
  3: [-123.1147377, 49.263435], // A switch
  4: [-123.11476, 49.2620], // track A, south
  5: [-123.1147556, 49.2635987], // diamond
  11: [-123.11476, 49.2650], // track B, north
  12: [-123.114775, 49.2637617], // B switch
  13: [-123.114792, 49.2634371], // B switch
  14: [-123.11482, 49.2620], // track B, south
};
const nodes = new Map<number, OsmNode>(
  Object.entries(pts).map(([id, [lon, lat]]) => [Number(id), { type: 'node', id: Number(id), lon, lat, tags: [2, 3, 12, 13].includes(Number(id)) ? { railway: 'switch' } : undefined }]),
);
const ways: OsmWay[] = [
  { type: 'way', id: 100, nodes: [1, 2, 3, 4] },
  { type: 'way', id: 200, nodes: [11, 12, 13, 14] },
  { type: 'way', id: 300, nodes: [2, 5, 13], tags: { service: 'crossover' } },
  { type: 'way', id: 400, nodes: [3, 5, 12], tags: { service: 'crossover' } },
];

describe('buildNetwork', () => {
  it('lets a diamond pass only straight across, not from one diagonal back onto the other', () => {
    const { fc } = buildNetwork(ways, nodes, new Map(), [], { source: 'test', generatedAt: '' });
    const diamond = fc.features.find((f) => f.properties.type === 'node' && f.properties.osmNode === 5)!;
    const p = diamond.properties as { kind: string; turns: [string, string][] };
    expect(p.kind).toBe('crossing');
    const pairs = p.turns.map((t) => t.map((e) => e.split('.')[0]).sort().join('-'));
    // Each turn continues along the same diagonal (way 300 or 400).
    expect(pairs.sort()).toEqual(['w300-w300', 'w400-w400']);
  });
});
