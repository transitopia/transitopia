// Compose a scenario track network: base network + optional future OSM track + custom track, then
// rebuild topology with the same code as the OSM import (PLAN.md §4.8). Pieces are joined wherever
// they share a coordinate; custom track endpoints snap to existing track within a few metres.

import { distM, localProjector, type LonLat } from "../geo.ts";
import { buildNetwork, type OsmNode, type OsmWay } from "../infra/network.ts";
import type { InfraCollection, LineKey, SegmentProps } from "../infra/types.ts";
import type { CustomTrackProps } from "./types.ts";

/** Custom track endpoints within this distance of existing track join it (m). */
const SNAP_M = 4;

export interface ComposeInput {
  base: InfraCollection;
  future?: InfraCollection;
  futureLines?: LineKey[];
  custom?: GeoJSON.FeatureCollection<GeoJSON.LineString, CustomTrackProps>;
  removeWays?: number[];
}

export function composeNetwork(input: ComposeInput): {
  fc: InfraCollection;
  stats: Record<string, number>;
} {
  const nodes = new Map<number, OsmNode>();
  const idByCoord = new Map<string, number>();
  let nextNode = 1;
  const key = (c: LonLat) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
  const nodeFor = (c: LonLat, tags?: Record<string, string>): number => {
    const k = key(c);
    let id = idByCoord.get(k);
    if (id === undefined) {
      id = nextNode++;
      idByCoord.set(k, id);
      nodes.set(id, {
        type: "node",
        id,
        lon: c[0],
        lat: c[1],
        ...(tags ? { tags } : {}),
      });
    } else if (tags) {
      const n = nodes.get(id)!;
      n.tags = { ...tags, ...n.tags };
    }
    return id;
  };

  // Node tags from the base network (switches, buffers, crossings) so kinds survive the rebuild.
  const nodeTag: Record<string, Record<string, string>> = {
    switch: { railway: "switch" },
    buffer: { railway: "buffer_stop" },
    crossing: { railway: "railway_crossing" },
  };
  for (const f of input.base.features) {
    if (f.properties.type === "node" && nodeTag[f.properties.kind])
      nodeFor(f.geometry.coordinates as LonLat, nodeTag[f.properties.kind]);
  }

  const ways: OsmWay[] = [];
  const wayLines = new Map<number, Set<LineKey>>();
  let nextWay = 1;
  const remove = new Set(input.removeWays ?? []);
  const addSegmentWay = (
    p: SegmentProps,
    coords: LonLat[],
    lines: LineKey[],
  ) => {
    const id = nextWay++;
    const tags: Record<string, string> = {
      railway: p.works ? "construction" : "subway",
      "viz:kind": p.kind,
    };
    if (p.name) tags.name = p.name;
    if (p.layer !== undefined) tags.layer = String(p.layer);
    if (p.bridge) tags.bridge = "yes";
    if (p.tunnel) tags.tunnel = "yes";
    if (p.maxspeed) tags.maxspeed = String(p.maxspeed);
    if (p.trackRef) tags["railway:track_ref"] = p.trackRef;
    ways.push({ type: "way", id, nodes: coords.map((c) => nodeFor(c)), tags });
    if (lines.length) wayLines.set(id, new Set(lines));
  };
  for (const f of input.base.features) {
    if (f.properties.type !== "segment" || remove.has(f.properties.osmWay))
      continue;
    addSegmentWay(
      f.properties,
      f.geometry.coordinates as LonLat[],
      f.properties.lines,
    );
  }
  let futureCount = 0;
  for (const f of input.future?.features ?? []) {
    if (f.properties.type !== "segment") continue;
    addSegmentWay(
      f.properties,
      f.geometry.coordinates as LonLat[],
      f.properties.lines.length ?
        f.properties.lines
      : (input.futureLines ?? []),
    );
    futureCount++;
  }

  // Custom track: snap endpoints to nearby existing vertices, or else split the nearest existing
  // track there (so crossovers can attach mid-segment).
  const allCoords = [...idByCoord.keys()].map(
    (k) => k.split(",").map(Number) as LonLat,
  );
  const coordOf = (id: number): LonLat => [
    nodes.get(id)!.lon,
    nodes.get(id)!.lat,
  ];
  const snap = (c: LonLat): LonLat => {
    let best: LonLat = c;
    let bd = SNAP_M;
    for (const e of allCoords) {
      const d = distM(c, e);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (bd < SNAP_M) return best;
    // Nearest point on any existing way; insert it as a vertex.
    const proj = localProjector(c[1]);
    const [px, py] = proj.toXY(c);
    let hit: { way: OsmWay; i: number; at: LonLat; d: number } | undefined;
    for (const w of ways) {
      for (let i = 0; i + 1 < w.nodes.length; i++) {
        const [ax, ay] = proj.toXY(coordOf(w.nodes[i]!));
        const [bx, by] = proj.toXY(coordOf(w.nodes[i + 1]!));
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const f =
          l2 > 0 ?
            Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2))
          : 0;
        const d = Math.hypot(ax + dx * f - px, ay + dy * f - py);
        if (d < SNAP_M && (!hit || d < hit.d) && f > 0 && f < 1) {
          const ll = proj.toLonLat(ax + dx * f, ay + dy * f);
          hit = {
            way: w,
            i,
            at: [Number(ll[0].toFixed(7)), Number(ll[1].toFixed(7))],
            d,
          };
        }
      }
    }
    if (!hit) return c;
    hit.way.nodes.splice(hit.i + 1, 0, nodeFor(hit.at));
    allCoords.push(hit.at);
    return hit.at;
  };
  let customCount = 0;
  for (const f of input.custom?.features ?? []) {
    const coords = [...(f.geometry.coordinates as LonLat[])];
    coords[0] = snap(coords[0]!);
    coords[coords.length - 1] = snap(coords[coords.length - 1]!);
    // Later custom pieces (e.g. crossovers) can join this one's vertices.
    for (const c of coords) allCoords.push(c);
    const p = f.properties ?? {};
    const id = nextWay++;
    const tags: Record<string, string> = {
      railway: "subway",
      "viz:kind": p.kind ?? "main",
    };
    if (p.name) tags.name = p.name;
    ways.push({ type: "way", id, nodes: coords.map((c) => nodeFor(c)), tags });
    if (p.lines?.length) wayLines.set(id, new Set(p.lines));
    customCount++;
  }

  // Stop positions carry over by coordinate.
  const stopNodes: OsmNode[] = [];
  for (const f of input.base.features) {
    if (f.properties.type !== "stop") continue;
    const id = nodeFor(f.geometry.coordinates as LonLat);
    const n = nodes.get(id)!;
    n.tags = {
      ...n.tags,
      public_transport: "stop_position",
      name: f.properties.name,
      ...(f.properties.railwayRef ?
        { "railway:ref": f.properties.railwayRef }
      : {}),
    };
    stopNodes.push(n);
  }

  const { fc, stats } = buildNetwork(ways, nodes, wayLines, stopNodes, {
    source: `${input.base.metadata.source}; scenario composition`,
    generatedAt: new Date().toISOString(),
  });
  return {
    fc,
    stats: { ...stats, futureSegments: futureCount, customTracks: customCount },
  };
}
