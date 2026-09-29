// Build the track network (segments, nodes with turns, stop positions) from way/node data
// (PLAN.md §4.1). Used by scripts/import-osm.ts for OpenStreetMap and by scenarios, which feed it the
// base network plus future/custom track.
//
// Segments are ways split at junctions/switches (ids "w<wayId>.<piece>", stable while the way is
// unchanged). Turns at each node are derived from geometry: a train may pass between two segment
// ends only if they continue nearly straight through the node, which models switches (no reversing
// through the frog) and diamond crossings without per-switch tagging.

import {
  cumulativeLengths,
  localProjector,
  projectOnto,
  round,
  type LonLat,
} from "../geo.ts";
import type {
  InfraCollection,
  InfraFeature,
  LineKey,
  NodeKind,
  SegmentEnd,
  SegmentKind,
  SegmentProps,
} from "./types.ts";

/** Max deviation from straight (degrees) for passing through a node. Real turnouts diverge ≲ 15°. */
const MAX_TURN_DEG = 35;
/** Distance along a segment used to measure its heading at a node (m). */
const HEADING_SAMPLE_M = 8;
/** Line colours spread from route-relation tracks to adjacent crossovers/pockets within this distance. */
const LINE_SPREAD_M = 3000;

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export function kindOf(tags: Record<string, string>): SegmentKind {
  // Explicit kind (scenarios, round-tripped networks).
  if (tags["viz:kind"]) return tags["viz:kind"] as SegmentKind;
  const name = tags.name ?? "";
  if (/tail/i.test(name)) return "tail";
  if (/pocket/i.test(name) && tags.service !== "yard") return "pocket";
  switch (tags.service) {
    case "yard":
      return "yard";
    case "siding":
      return "siding";
    case "crossover":
      return "crossover";
    case "spur":
      return "spur";
  }
  if (tags.usage === "test") return "yard";
  return "main";
}

interface PieceBuild {
  id: string;
  way: OsmWay;
  nodeIds: number[];
}

export function buildNetwork(
  ways: OsmWay[],
  nodes: Map<number, OsmNode>,
  wayLines: Map<number, Set<LineKey>>,
  stopNodes: OsmNode[],
  meta: InfraCollection["metadata"],
): { fc: InfraCollection; stats: Record<string, number> } {
  // Vertex nodes: way endpoints, nodes shared between ways (or repeated), and tagged nodes.
  const uses = new Map<number, number>();
  for (const w of ways)
    for (const n of w.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const isVertex = (n: number, i: number, w: OsmWay) => {
    if (i === 0 || i === w.nodes.length - 1) return true;
    if ((uses.get(n) ?? 0) > 1) return true;
    const r = nodes.get(n)?.tags?.railway;
    return r === "switch" || r === "buffer_stop" || r === "railway_crossing";
  };

  const pieces: PieceBuild[] = [];
  for (const w of ways) {
    let start = 0;
    let k = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isVertex(w.nodes[i]!, i, w)) continue;
      pieces.push({
        id: `w${w.id}.${k++}`,
        way: w,
        nodeIds: w.nodes.slice(start, i + 1),
      });
      start = i;
    }
  }

  const coordOf = (n: number): LonLat => {
    const nd = nodes.get(n);
    if (!nd) throw new Error(`OSM node ${n} missing geometry`);
    return [round(nd.lon, 7), round(nd.lat, 7)];
  };

  // Segment ends at each vertex.
  const endsAt = new Map<
    number,
    { end: SegmentEnd; away: [number, number] }[]
  >();
  const segFeatures: InfraFeature[] = [];
  const segProps = new Map<string, SegmentProps>();
  const segCoords = new Map<string, LonLat[]>();
  for (const p of pieces) {
    const coords = p.nodeIds.map(coordOf);
    const cum = cumulativeLengths(coords);
    const length = cum[cum.length - 1]!;
    const tags = p.way.tags ?? {};
    const props: SegmentProps = {
      type: "segment",
      id: p.id,
      kind: kindOf(tags),
      lines: [...(wayLines.get(p.way.id) ?? [])].sort(),
      from: `n${p.nodeIds[0]}`,
      to: `n${p.nodeIds[p.nodeIds.length - 1]}`,
      length: round(length, 2),
      osmWay: p.way.id,
    };
    if (tags.name) props.name = tags.name;
    if (tags["railway:track_ref"]) props.trackRef = tags["railway:track_ref"];
    if (tags.maxspeed && Number.isFinite(parseFloat(tags.maxspeed)))
      props.maxspeed = parseFloat(tags.maxspeed);
    if (tags.layer) props.layer = Number(tags.layer);
    if (tags.bridge && tags.bridge !== "no") props.bridge = true;
    if (tags.tunnel && tags.tunnel !== "no") props.tunnel = true;
    if (tags.railway !== "subway") props.works = true;
    segProps.set(p.id, props);
    segCoords.set(p.id, coords);
    segFeatures.push({
      type: "Feature",
      properties: props,
      geometry: { type: "LineString", coordinates: coords },
    });

    // Heading pointing away from each end, sampled a few metres in.
    const proj = localProjector(coords[0]![1]);
    const sampleAt = (fromStart: boolean): [number, number] => {
      const target = Math.min(HEADING_SAMPLE_M, length);
      let idx = fromStart ? 1 : coords.length - 2;
      if (fromStart)
        while (idx < coords.length - 1 && cum[idx]! < target) idx++;
      else while (idx > 0 && length - cum[idx]! < target) idx--;
      const [ax, ay] = proj.toXY(
        fromStart ? coords[0]! : coords[coords.length - 1]!,
      );
      const [bx, by] = proj.toXY(coords[idx]!);
      const l = Math.hypot(bx - ax, by - ay) || 1;
      return [(bx - ax) / l, (by - ay) / l];
    };
    for (const [nodeId, end, away] of [
      [p.nodeIds[0]!, `${p.id}:0` as SegmentEnd, sampleAt(true)],
      [
        p.nodeIds[p.nodeIds.length - 1]!,
        `${p.id}:1` as SegmentEnd,
        sampleAt(false),
      ],
    ] as const) {
      let list = endsAt.get(nodeId);
      if (!list) endsAt.set(nodeId, (list = []));
      list.push({ end, away });
    }
  }

  // Nodes and turns.
  const nodeFeatures: InfraFeature[] = [];
  const cosLimit = Math.cos(((180 - MAX_TURN_DEG) * Math.PI) / 180);
  const stats: Record<string, number> = {};
  const adjacency = new Map<string, Set<string>>(); // segment → segments reachable by a turn
  const dot = (a: { away: [number, number] }, b: { away: [number, number] }) =>
    a.away[0] * b.away[0] + a.away[1] * b.away[1];
  for (const [nodeId, ends] of endsAt) {
    const turns: [SegmentEnd, SegmentEnd][] = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i]!;
        const b = ends[j]!;
        // Away-vectors nearly opposite ⇒ straight through.
        if (dot(a, b) <= cosLimit) turns.push([a.end, b.end]);
      }
    }
    const tag = nodes.get(nodeId)?.tags?.railway;
    // A diamond (the middle of a double crossover) has no moving parts: each end continues only to
    // the end most nearly opposite. At flat crossovers the diagonals meet at < MAX_TURN_DEG, which
    // would otherwise allow a zig-zag from one diagonal onto the other and back to the same track.
    if (ends.length === 4 && tag !== "switch" && turns.length > 2) {
      const opposite = (a: (typeof ends)[number]) =>
        ends.reduce(
          (best, b) => (b !== a && dot(a, b) < dot(a, best) ? b : best),
          ends.find((b) => b !== a)!,
        );
      const keep = turns.filter(([ea, eb]) => {
        const a = ends.find((e) => e.end === ea)!;
        const b = ends.find((e) => e.end === eb)!;
        return opposite(a) === b && opposite(b) === a;
      });
      if (keep.length === 2) turns.splice(0, turns.length, ...keep);
    }
    let kind: NodeKind;
    if (ends.length === 1) kind = tag === "buffer_stop" ? "buffer" : "end";
    else if (
      tag === "railway_crossing"
      || (ends.length === 4 && turns.length === 2)
    )
      kind = "crossing";
    else if (ends.length >= 3 || tag === "switch") kind = "switch";
    else kind = "link";
    stats[kind] = (stats[kind] ?? 0) + 1;
    if (ends.length >= 2 && turns.length === 0)
      stats.noTurns = (stats.noTurns ?? 0) + 1;
    for (const [a, b] of turns) {
      const sa = a.slice(0, a.lastIndexOf(":"));
      const sb = b.slice(0, b.lastIndexOf(":"));
      if (!adjacency.has(sa)) adjacency.set(sa, new Set());
      if (!adjacency.has(sb)) adjacency.set(sb, new Set());
      adjacency.get(sa)!.add(sb);
      adjacency.get(sb)!.add(sa);
    }
    const nd = nodes.get(nodeId)!;
    nodeFeatures.push({
      type: "Feature",
      properties: {
        type: "node",
        id: `n${nodeId}`,
        kind,
        turns,
        osmNode: nodeId,
      },
      geometry: {
        type: "Point",
        coordinates: [round(nd.lon, 7), round(nd.lat, 7)],
      },
    });
  }

  // Spread line membership to non-yard segments without it (crossovers, pockets, tails), by BFS
  // from the nearest line track.
  const unassigned = [...segProps.values()].filter(
    (s) => !s.lines.length && s.kind !== "yard",
  );
  for (const s of unassigned) {
    const seen = new Set([s.id]);
    let frontier = [{ id: s.id, dist: 0 }];
    const found = new Set<LineKey>();
    while (frontier.length && !found.size) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        for (const nb of adjacency.get(f.id) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const p = segProps.get(nb)!;
          const d = f.dist + p.length;
          if (d > LINE_SPREAD_M) continue;
          if (p.lines.length && p.kind === "main")
            for (const l of p.lines) found.add(l);
          else next.push({ id: nb, dist: d });
        }
      }
      frontier = next;
    }
    s.lines = [...found].sort();
  }

  // Stop positions snapped to the segment containing their node.
  const segByNode = new Map<number, string[]>();
  for (const p of pieces)
    for (const n of p.nodeIds)
      (segByNode.get(n) ?? segByNode.set(n, []).get(n)!).push(p.id);
  const stopFeatures: InfraFeature[] = [];
  for (const s of stopNodes) {
    const segs = segByNode.get(s.id);
    if (!segs?.length) continue;
    const segId = segs[0]!;
    const coords = segCoords.get(segId)!;
    const cum = cumulativeLengths(coords);
    const offset = projectOnto(coords, cum, [s.lon, s.lat]).along;
    stopFeatures.push({
      type: "Feature",
      properties: {
        type: "stop",
        name: s.tags?.name ?? "",
        ...(s.tags?.["railway:ref"] ?
          { railwayRef: s.tags["railway:ref"] }
        : {}),
        segment: segId,
        offset: round(offset, 2),
        osmNode: s.id,
      },
      geometry: {
        type: "Point",
        coordinates: [round(s.lon, 7), round(s.lat, 7)],
      },
    });
  }

  stats.segments = segFeatures.length;
  stats.stopPositions = stopFeatures.length;
  return {
    fc: {
      type: "FeatureCollection",
      metadata: meta,
      features: [...segFeatures, ...nodeFeatures, ...stopFeatures],
    },
    stats,
  };
}
