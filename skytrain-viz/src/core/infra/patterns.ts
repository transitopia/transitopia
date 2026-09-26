// Route GTFS stop patterns over the track graph: each consecutive platform pair becomes a path, with
// the train's direction carried from hop to hop (no reversing between stops). Used by the validator
// and by movement building (PLAN.md §4.4).

import type { PlanPattern, ServicePlan } from '../plan/types.ts';
import type { Dir, Path, TrackGraph, TrackPos } from './graph.ts';
import type { PlatformAssignment } from './platforms.ts';

export interface PatternRoute {
  pattern: PlanPattern;
  /** Track position of each stop. */
  positions: TrackPos[];
  /** Path for each hop i → i+1 (undefined when unroutable). */
  hops: (Path | undefined)[];
  /** Direction of travel when departing the first stop / arriving at the last. */
  startDir?: Dir;
  endDir?: Dir;
  /** Stop-pair names that couldn't be routed. */
  failures: string[];
}

export function routePattern(
  g: TrackGraph,
  plan: ServicePlan,
  platforms: Map<string, PlatformAssignment>,
  pattern: PlanPattern,
): PatternRoute {
  const positions: TrackPos[] = [];
  const failures: string[] = [];
  for (const si of pattern.stops) {
    const a = platforms.get(plan.stops[si]!.id);
    positions.push(a ? a.pos : { seg: '', offset: 0 });
  }
  const hops: (Path | undefined)[] = [];
  // Try both initial directions; keep the one that routes the whole pattern best.
  let best: { hops: (Path | undefined)[]; fails: number; len: number; startDir?: Dir } | undefined;
  for (const d0 of [1, -1] as Dir[]) {
    const hs: (Path | undefined)[] = [];
    let dir: Dir | undefined = d0;
    let fails = 0;
    let len = 0;
    let startDir: Dir | undefined;
    for (let i = 0; i + 1 < positions.length; i++) {
      const a = positions[i]!;
      const b = positions[i + 1]!;
      const p: Path | null = a.seg && b.seg ? g.route(a, b, { fromDir: dir, allowReversals: false, maxLength: 12_000 }) : null;
      if (!p || p.reversals > 0) {
        hs.push(undefined);
        fails++;
        dir = undefined;
        continue;
      }
      if (i === 0) startDir = p.startDir;
      hs.push(p);
      len += p.length;
      dir = p.endDir;
    }
    if (!best || fails < best.fails || (fails === best.fails && len < best.len)) best = { hops: hs, fails, len, startDir };
  }
  hops.push(...best!.hops);
  hops.forEach((h, i) => {
    if (!h) failures.push(`${plan.stops[pattern.stops[i]!]!.name} → ${plan.stops[pattern.stops[i + 1]!]!.name}`);
  });
  const last = hops[hops.length - 1];
  return { pattern, positions, hops, startDir: best!.startDir, endDir: last?.endDir, failures };
}
