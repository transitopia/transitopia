// Where trains wait at termini (packages/transit-core/DESIGN.md#movements-and-playback): an in-place
// turnback waits at the platform, or pulled up to the buffer of a dead-ended platform track so it
// clears the switch behind it, or on another of the line's dead-ended tracks at the station. Used by
// run inference to allocate berths and by line geometry to colour the track they stand on.

import { distM } from "../geo.ts";
import type { PlanStop } from "../plan/types.ts";
import type { Dir, PathPiece, TrackGraph, TrackPos } from "./graph.ts";
import type { LineKey, SegmentKind } from "./types.ts";

/** Platforms sit on running track, never on crossovers, spurs or in yards. */
export const PLATFORM_KINDS = new Set<SegmentKind>([
  "main",
  "pocket",
  "tail",
  "siding",
]);
/** Dead-ended tracks this close to a stop are its berths (m). */
const STUB_NEAR_M = 150;
/** A pulled-up train stops this far short of the buffer (m). */
const BUFFER_MARGIN_M = 10;

/** On a dead-ended segment, the berth pulled up to the buffer for a train of length `len`. */
export function pullUp(g: TrackGraph, pos: TrackPos, len: number): TrackPos {
  const s = g.segment(pos.seg);
  if (g.isDeadEnd(pos.seg, -1))
    return {
      seg: pos.seg,
      offset: Math.min(s.length - len / 2, len / 2 + BUFFER_MARGIN_M),
    };
  if (g.isDeadEnd(pos.seg, 1))
    return {
      seg: pos.seg,
      offset: Math.max(len / 2, s.length - len / 2 - BUFFER_MARGIN_M),
    };
  return pos;
}

/** The line's dead-ended running tracks near a stop. */
export function stubsNear(
  g: TrackGraph,
  stop: PlanStop,
  line: string,
): string[] {
  return [...g.segments.values()]
    .filter(
      (sg) =>
        PLATFORM_KINDS.has(sg.kind)
        && sg.lines.includes(line as LineKey)
        && (g.isDeadEnd(sg.id, 1) || g.isDeadEnd(sg.id, -1))
        && sg.coords.some((c) => distM(c, [stop.lon, stop.lat]) < STUB_NEAR_M),
    )
    .map((sg) => sg.id);
}

/**
 * Where a train of length `len` arriving at `pos` (the last stop's platform) may wait to turn back,
 * in order of preference: the platform (pulled up to the buffer when that's within `maxPullUpM`;
 * farther, the dead end is closed track, not a berth), then the line's other dead-ended tracks there.
 */
export function terminusBerths(
  g: TrackGraph,
  pos: TrackPos,
  stubs: string[],
  len: number,
  maxPullUpM: number,
): TrackPos[] {
  const up = pullUp(g, pos, len);
  const out = [Math.abs(up.offset - pos.offset) <= maxPullUpM ? up : pos];
  for (const seg of stubs)
    if (!out.some((x) => x.seg === seg))
      out.push(pullUp(g, { seg, offset: 0 }, len));
  return out;
}

/** The track a train of length `len` centred at `pos` stands on (straightest way at switches). */
export function trainSpan(
  g: TrackGraph,
  pos: TrackPos,
  len: number,
): PathPiece[] {
  const out: PathPiece[] = [];
  for (const dir of [1, -1] as Dir[]) {
    let seg = pos.seg;
    let offset = pos.offset;
    let d = dir;
    let left = len / 2;
    for (let guard = 0; guard < 20 && left > 1e-6; guard++) {
      const s = g.segment(seg);
      const to =
        d === 1 ?
          Math.min(s.length, offset + left)
        : Math.max(0, offset - left);
      out.push({ seg, from: offset, to });
      left -= Math.abs(to - offset);
      const next = left > 1e-6 ? g.straightest(seg, d) : undefined;
      if (!next) break;
      seg = next.seg;
      d = next.dir;
      offset = d === 1 ? 0 : g.segment(seg).length;
    }
  }
  return out;
}
