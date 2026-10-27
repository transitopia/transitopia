// Joining classified ways into chains (packages/cycling-core/README.md#chains): consecutive ways with
// the same attributes, broken wherever more than two cycling ways meet. A chain is what the map
// highlights and selects, the same in every tile and at every zoom, and it knows its OSM ways.

export type LonLat = [number, number];

export interface ClassifiedWay<A> {
  id: number;
  nodes: readonly number[];
  coords: readonly LonLat[];
  attrs: A;
}

export interface Chain<A> {
  attrs: A;
  /** Its ways, in order along it. */
  wayIds: number[];
  coords: LonLat[];
}

interface End {
  way: number;
  /** Whether it's the way's first node (else its last). */
  start: boolean;
}

/**
 * Join ways whose `key` is the same where exactly two cycling ways meet end to end (a node any other
 * way passes through, or a third way ends at, is a junction). `directed` ways (one-way) only join
 * head to tail, keeping their direction; the others are turned around as needed.
 */
export function joinChains<A>(
  ways: readonly ClassifiedWay<A>[],
  key: (attrs: A) => string,
  directed: (attrs: A) => boolean,
): Chain<A>[] {
  // How many way ends meet at each node, counting a way passing through as two.
  const degree = new Map<number, number>();
  const ends = new Map<number, End[]>();
  const bump = (n: number, by: number) =>
    degree.set(n, (degree.get(n) ?? 0) + by);
  ways.forEach((w, i) => {
    w.nodes.forEach((n, j) => {
      if (j > 0 && j < w.nodes.length - 1) bump(n, 2);
    });
    for (const [n, start] of [
      [w.nodes[0]!, true],
      [w.nodes.at(-1)!, false],
    ] as const) {
      bump(n, 1);
      let list = ends.get(n);
      if (!list) ends.set(n, (list = []));
      list.push({ way: i, start });
    }
  });
  const keys = ways.map((w) => key(w.attrs));
  const used = new Uint8Array(ways.length);

  /** The way to join at node `n` from way `from`, if there is exactly one that fits. */
  const next = (n: number, from: number): End | undefined => {
    if (degree.get(n) !== 2) return undefined;
    const other = ends.get(n)!.find((e) => e.way !== from);
    if (!other || used[other.way] || keys[other.way] !== keys[from])
      return undefined;
    return other;
  };

  const chains: Chain<A>[] = [];
  ways.forEach((first, i) => {
    if (used[i]) return;
    used[i] = 1;
    const isDirected = directed(first.attrs);
    // Pieces in order, each with whether it runs backwards.
    const pieces: { way: number; reversed: boolean }[] = [
      { way: i, reversed: false },
    ];
    // Forwards from the last node.
    for (let at = pieces[0]!; ;) {
      const w = ways[at.way]!;
      const n = at.reversed ? w.nodes[0]! : w.nodes.at(-1)!;
      const e = next(n, at.way);
      if (!e || (isDirected && !e.start)) break;
      used[e.way] = 1;
      at = { way: e.way, reversed: !e.start };
      pieces.push(at);
    }
    // Backwards from the first node.
    for (let at = pieces[0]!; ;) {
      const w = ways[at.way]!;
      const n = at.reversed ? w.nodes.at(-1)! : w.nodes[0]!;
      const e = next(n, at.way);
      if (!e || (isDirected && e.start)) break;
      used[e.way] = 1;
      at = { way: e.way, reversed: e.start };
      pieces.unshift(at);
    }
    const coords: LonLat[] = [];
    for (const p of pieces) {
      const c = ways[p.way]!.coords;
      const ordered = p.reversed ? [...c].reverse() : c;
      coords.push(...(coords.length ? ordered.slice(1) : ordered));
    }
    chains.push({
      attrs: first.attrs,
      wayIds: pieces.map((p) => ways[p.way]!.id),
      coords,
    });
  });
  return chains;
}
