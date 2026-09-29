// Map GTFS rail platform stops onto track positions (docs/skytrain-viz-PLAN.md §4.1).
//
// GTFS platform coordinates are platform-specific but not always precise, and some tracks are
// stacked (Dunsmuir tunnel, King Edward), so "nearest track" is ambiguous. We choose, for every
// platform, one of its nearby candidate tracks so that the whole timetable is operable:
//
//  1. Route consistency: within each stop pattern, consecutive stops must be reachable without
//     reversing (Viterbi over candidates × direction; cost = route length + distance penalty).
//  2. Distinct tracks: different numbered platforms at a station are different tracks, except an
//     arrival-only and a departure-only platform at a terminus, which may be one berth.
//  3. Turnbacks: at each terminus, arriving trains must be able to reach a departure platform of
//     their line (reversing at dead ends, in pockets/tails, or in place).
//
// Each stop takes the candidate most trips agree on. Rules 2 and 3 are enforced by trying pinned
// alternatives for the stations involved and keeping the cheapest overall evaluation. Overrides pin
// a stop (by name) to the track nearest a given point when the data is wrong.

import type { LonLat } from "../geo.ts";
import type { PlanStop, ServicePlan } from "../plan/types.ts";
import type { Dir, TrackGraph, TrackPos } from "./graph.ts";
import type { SegmentKind } from "./types.ts";

export interface PlatformOverride {
  /** GTFS stop_name, e.g. "Waterfront Station @ Platform 2". */
  stop: string;
  /** A point on the intended track (the nearest track to it is used). */
  near: LonLat;
  note?: string;
}

/**
 * Pin stops by the role of the trip's pattern, when GTFS platform numbers don't say which track a
 * train uses (e.g. temporary single-track working). Applies to patterns that start or end at
 * `station` ('terminating') or pass through it ('through'); `pins` maps station names to a point on
 * the track those patterns use there.
 */
export interface PatternPlatformRule {
  station: string;
  patterns: "terminating" | "through";
  pins: Record<string, LonLat>;
  note?: string;
}

export interface PlatformAssignment {
  stopId: string;
  name: string;
  pos: TrackPos;
  /** Distance from the GTFS coordinate to the chosen track (m). */
  dist: number;
  method: "override" | "consistent" | "nearest";
  /** Share of trip weight that agreed with the chosen candidate. */
  agreement: number;
}

export interface PlatformReport {
  assignments: Map<string, PlatformAssignment>;
  unmapped: string[];
  /** Consecutive stop pairs (by name) that couldn't be routed without reversing. */
  breaks: string[];
  /** Termini (stop name + route) where arriving trains can reach neither a departure platform nor a yard. */
  turnbackFailures: string[];
  /** Per-pattern positions from PatternPlatformRules: pattern id → stop index → track position. */
  patternPositions: Map<number, Map<number, TrackPos>>;
}

const CANDIDATE_RADIUS_M = 60;
const MAX_CANDIDATES = 4;
/** Route-metres charged per metre of distance from the GTFS coordinate. */
const DIST_WEIGHT = 10;
const BREAK_COST = 1e9;
const TURNBACK_FAIL_COST = 1e7;
/** Turnbacks longer than this aren't considered (m). */
const MAX_TURNBACK_M = 4000;
/** A trip may instead end by pulling in to a yard within this distance (m). */
const MAX_PULL_IN_M = 12_000;
const YARD = new Set<SegmentKind>(["yard"]);
/** Platforms sit on running track, never on crossovers, spurs or in yards. */
const PLATFORM_KINDS = new Set<SegmentKind>([
  "main",
  "pocket",
  "tail",
  "siding",
]);

type Cand = TrackPos & { dist: number };
type Pins = Map<number, Set<number>>;

interface PatternEnds {
  route: string;
  weight: number;
  first: { si: number; ci: number; dir: Dir; pin?: TrackPos | undefined };
  last: { si: number; ci: number; dir: Dir; pin?: TrackPos | undefined };
}

interface Solution {
  total: number;
  votes: Map<number, number[]>;
  breaks: Set<string>;
  ends: PatternEnds[];
  turnbackFailures: Set<string>;
}

export function mapPlatforms(
  g: TrackGraph,
  plan: ServicePlan,
  routeKeys: Set<string>,
  overrides: PlatformOverride[] = [],
  patternRules: PatternPlatformRule[] = [],
): PlatformReport {
  const railPatterns = plan.patterns.filter((p) => routeKeys.has(p.route));
  const tripsPerPattern = new Map<number, number>();
  for (const t of plan.trips)
    tripsPerPattern.set(t.pattern, (tripsPerPattern.get(t.pattern) ?? 0) + 1);
  const railStops = [...new Set(railPatterns.flatMap((p) => p.stops))];

  // --- candidates ---
  const overrideByName = new Map(overrides.map((o) => [o.stop, o]));
  const candidates = new Map<number, Cand[]>();
  const candidatesFor = (si: number): Cand[] => {
    let c = candidates.get(si);
    if (c) return c;
    const s = plan.stops[si]!;
    const o = overrideByName.get(s.name);
    const near = g.nearest(
      o ? o.near : [s.lon, s.lat],
      o ? 15 : CANDIDATE_RADIUS_M,
      PLATFORM_KINDS,
    );
    const seen = new Set<string>();
    c = near
      .filter((n) => (seen.has(n.seg) ? false : (seen.add(n.seg), true)))
      .slice(0, o ? 1 : MAX_CANDIDATES);
    candidates.set(si, c);
    return c;
  };

  // --- per-pattern pins (role-based rules) ---
  const stationName = (si: number) => {
    const s = plan.stops[si]!;
    return (
      plan.stations.find((x) => x.id === s.parent)?.name
      ?? s.name.replace(/\s+Station.*$/, "")
    );
  };
  const pinned = new Map<number, Map<number, Cand>>();
  for (const p of railPatterns) {
    const ends = new Set([
      stationName(p.stops[0]!),
      stationName(p.stops[p.stops.length - 1]!),
    ]);
    const names = p.stops.map(stationName);
    for (const rule of patternRules) {
      const applies =
        rule.patterns === "terminating" ?
          ends.has(rule.station)
        : names.includes(rule.station) && !ends.has(rule.station);
      if (!applies) continue;
      names.forEach((n, i) => {
        const pin = rule.pins[n];
        if (!pin) return;
        const c = g.nearest(pin, 10, PLATFORM_KINDS)[0];
        if (!c) return;
        const s = plan.stops[p.stops[i]!]!;
        const m = pinned.get(p.id) ?? pinned.set(p.id, new Map()).get(p.id)!;
        m.set(i, {
          ...c,
          dist:
            g
              .nearest([s.lon, s.lat], 200, PLATFORM_KINDS)
              .find((x) => x.seg === c.seg)?.dist ?? 0,
        });
      });
    }
  }
  /** Candidates for stop i of a pattern: its pin if any, else the stop's candidates. */
  const candsAt = (patId: number, i: number, si: number): Cand[] => {
    const pin = pinned.get(patId)?.get(i);
    return pin ? [pin] : candidatesFor(si);
  };

  // --- cached routing ---
  const posKey = (p: TrackPos) => `${p.seg}@${p.offset.toFixed(1)}`;
  const hopCache = new Map<
    string,
    { len: number; startDir: Dir; endDir: Dir } | null
  >();
  const hop = (a: TrackPos, dir: Dir | undefined, b: TrackPos) => {
    const key = `${posKey(a)}|${dir ?? 0}|${posKey(b)}`;
    let r = hopCache.get(key);
    if (r !== undefined) return r;
    const p = g.route(a, b, {
      fromDir: dir,
      allowReversals: false,
      maxLength: 8000,
    });
    r =
      p && p.reversals === 0 ?
        { len: p.length, startDir: p.startDir, endDir: p.endDir }
      : null;
    hopCache.set(key, r);
    return r;
  };
  const yardCache = new Map<string, boolean>();
  /** Can a train ending a trip here run to a yard instead of turning back (pull-in)? */
  const canPullIn = (a: TrackPos, aDir: Dir) => {
    const key = `${posKey(a)}|${aDir}`;
    let ok = yardCache.get(key);
    if (ok !== undefined) return ok;
    ok =
      g.route(a, null, {
        fromDir: aDir,
        allowReversals: true,
        allowReverseAtStart: true,
        goalKinds: YARD,
        maxLength: MAX_PULL_IN_M,
      }) !== null;
    yardCache.set(key, ok);
    return ok;
  };
  const tbCache = new Map<string, boolean>();
  const canTurn = (a: TrackPos, aDir: Dir, d: TrackPos, dDir: Dir) => {
    const key = `${posKey(a)}|${aDir}|${posKey(d)}|${dDir}`;
    let ok = tbCache.get(key);
    if (ok !== undefined) return ok;
    ok =
      g.route(a, d, {
        fromDir: aDir,
        toDir: dDir,
        allowReversals: true,
        allowReverseAtStart: true,
        allowReverseAtTarget: true,
        maxLength: MAX_TURNBACK_M,
      }) !== null;
    tbCache.set(key, ok);
    return ok;
  };

  // --- station roles ---
  const stationOf = (si: number) =>
    plan.stops[si]!.parent ?? plan.stops[si]!.name.replace(/\s*@.*$/, "");
  const role = new Map<number, Set<"arr" | "dep" | "thru">>();
  for (const p of railPatterns) {
    p.stops.forEach((si, i) => {
      const r = role.get(si) ?? new Set();
      r.add(
        i === 0 ? "dep"
        : i === p.stops.length - 1 ? "arr"
        : "thru",
      );
      role.set(si, r);
    });
  }
  const only = (si: number, r: "arr" | "dep") => {
    const x = role.get(si);
    return x?.size === 1 && x.has(r);
  };
  const mayShare = (a: number, b: number) =>
    (only(a, "arr") && only(b, "dep")) || (only(a, "dep") && only(b, "arr"));

  // --- evaluation ---
  const pick = (sol: Solution, pins: Pins, si: number): number => {
    const pin = pins.get(si);
    if (pin?.size === 1) return [...pin][0]!;
    const v = sol.votes.get(si);
    return v ? v.indexOf(Math.max(...v)) : 0;
  };

  const evaluate = (pins: Pins): Solution => {
    const votes = new Map<number, number[]>();
    const breaks = new Set<string>();
    const ends: PatternEnds[] = [];
    let total = 0;
    const allowed = (si: number) => {
      const pin = pins.get(si);
      return candidatesFor(si)
        .map((_, i) => i)
        .filter((i) => !pin || pin.has(i));
    };
    for (const pat of railPatterns) {
      const weight = tripsPerPattern.get(pat.id) ?? 1;
      const stops = pat.stops;
      type Cell = { cost: number; back?: [number, number] };
      const layers: Cell[][][] = [];
      const inf = (): Cell[] => [{ cost: Infinity }, { cost: Infinity }];
      const c0 = candsAt(pat.id, 0, stops[0]!);
      const a0 = new Set(pinned.get(pat.id)?.has(0) ? [0] : allowed(stops[0]!));
      layers.push(
        c0.map((c, i) =>
          a0.has(i) ?
            [{ cost: c.dist * DIST_WEIGHT }, { cost: c.dist * DIST_WEIGHT }]
          : inf(),
        ),
      );
      let broken = false;
      for (let i = 1; i < stops.length && !broken; i++) {
        const prevC = candsAt(pat.id, i - 1, stops[i - 1]!);
        const curC = candsAt(pat.id, i, stops[i]!);
        const curAllowed =
          pinned.get(pat.id)?.has(i) ? [0] : allowed(stops[i]!);
        const layer: Cell[][] = curC.map(inf);
        for (let a = 0; a < prevC.length; a++) {
          for (let da = 0; da < 2; da++) {
            const base = layers[i - 1]![a]![da]!.cost;
            if (!Number.isFinite(base)) continue;
            // At the first stop the direction is free; afterwards it is the arrival direction.
            const dir: Dir | undefined =
              i === 1 ? undefined
              : da === 0 ? 1
              : -1;
            for (const b of curAllowed) {
              const r = hop(prevC[a]!, dir, curC[b]!);
              if (!r) continue;
              const db = r.endDir === 1 ? 0 : 1;
              const cost = base + r.len + curC[b]!.dist * DIST_WEIGHT;
              if (cost < layer[b]![db]!.cost)
                layer[b]![db] = { cost, back: [a, da] };
            }
          }
        }
        if (
          layer.every(
            (c) => !Number.isFinite(c[0]!.cost) && !Number.isFinite(c[1]!.cost),
          )
        ) {
          breaks.add(
            `${plan.stops[stops[i - 1]!]!.name} → ${plan.stops[stops[i]!]!.name}`,
          );
          broken = true;
        } else layers.push(layer);
      }
      if (broken) {
        total += weight * BREAK_COST;
        continue;
      }
      let bi = -1;
      let bd = 0;
      let bc = Infinity;
      layers[layers.length - 1]!.forEach((c, ci) =>
        c.forEach((cell, di) => {
          if (cell.cost < bc) [bc, bi, bd] = [cell.cost, ci, di];
        }),
      );
      total += weight * bc;
      const chosen: number[] = new Array(layers.length);
      const lastDir: Dir = bd === 0 ? 1 : -1;
      for (let i = layers.length - 1; i >= 0; i--) {
        chosen[i] = bi;
        const si = stops[i]!;
        if (!pinned.get(pat.id)?.has(i)) {
          const v =
            votes.get(si) ?? new Array(candidatesFor(si).length).fill(0);
          v[bi] += weight;
          votes.set(si, v);
        }
        const back = layers[i]![bi]![bd]!.back;
        if (back) [bi, bd] = back;
      }
      const n = stops.length;
      const firstHop = hop(
        candsAt(pat.id, 0, stops[0]!)[chosen[0]!]!,
        undefined,
        candsAt(pat.id, 1, stops[1]!)[chosen[1]!]!,
      )!;
      ends.push({
        route: pat.route,
        weight,
        first: {
          si: stops[0]!,
          ci: chosen[0]!,
          dir: firstHop.startDir,
          pin: pinned.get(pat.id)?.get(0),
        },
        last: {
          si: stops[n - 1]!,
          ci: chosen[n - 1]!,
          dir: lastDir,
          pin: pinned.get(pat.id)?.get(n - 1),
        },
      });
    }

    // Turnbacks, using each stop's consensus candidate.
    const sol: Solution = {
      total,
      votes,
      breaks,
      ends,
      turnbackFailures: new Set(),
    };
    const posOf = (si: number) => candidatesFor(si)[pick(sol, pins, si)]!;
    const deps = new Map<string, { pos: TrackPos; dir: Dir }[]>();
    for (const e of ends) {
      const k = `${e.route}|${stationOf(e.first.si)}`;
      (deps.get(k) ?? deps.set(k, []).get(k)!).push({
        pos: e.first.pin ?? posOf(e.first.si),
        dir: e.first.dir,
      });
    }
    const checked = new Map<string, boolean>();
    for (const e of ends) {
      const k = `${e.route}|${stationOf(e.last.si)}`;
      const ds = deps.get(k);
      if (!ds) continue; // trips end where none of this line start (e.g. heading to a yard)
      const a = e.last.pin ?? posOf(e.last.si);
      const ck = `${k}|${posKey(a)}|${e.last.dir}`;
      let ok = checked.get(ck);
      if (ok === undefined)
        checked.set(
          ck,
          (ok =
            ds.some((d) => canTurn(a, e.last.dir, d.pos, d.dir))
            || canPullIn(a, e.last.dir)),
        );
      if (!ok) {
        sol.turnbackFailures.add(`${plan.stops[e.last.si]!.name} (${e.route})`);
        sol.total += TURNBACK_FAIL_COST;
      }
    }
    return sol;
  };

  /** Try every combination of candidates for `group`; `distinct(a, b)` = a and b need different tracks. */
  const bestPinning = (
    pins: Pins,
    group: number[],
    distinct: (a: number, b: number) => boolean,
  ) => {
    let best: { total: number; pins: Pins } | undefined;
    const choice: number[] = [];
    const recurse = (k: number) => {
      if (k === group.length) {
        const trial = new Map(pins);
        group.forEach((si, j) => trial.set(si, new Set([choice[j]!])));
        const r = evaluate(trial);
        if (!best || r.total < best.total)
          best = { total: r.total, pins: trial };
        return;
      }
      const si = group[k]!;
      const pinned = pins.get(si);
      candidatesFor(si).forEach((c, ci) => {
        if (pinned && !pinned.has(ci)) return;
        for (let j = 0; j < k; j++) {
          if (
            stationOf(group[j]!) === stationOf(si)
            && distinct(group[j]!, si)
            && candidatesFor(group[j]!)[choice[j]!]!.seg === c.seg
          )
            return;
        }
        choice[k] = ci;
        recurse(k + 1);
      });
    };
    recurse(0);
    return best;
  };

  const pins: Pins = new Map();
  let sol = evaluate(pins);
  const numbered = railStops.filter((si) => plan.stops[si]!.platform);
  // Stations adjacent in any pattern, for joint re-solving.
  const neighbours = new Map<string, Set<string>>();
  for (const p of railPatterns) {
    for (let i = 1; i < p.stops.length; i++) {
      const a = stationOf(p.stops[i - 1]!);
      const b = stationOf(p.stops[i]!);
      (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
      (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
    }
  }
  const comboCount = (group: number[]) =>
    group.reduce((n, si) => n * Math.max(1, candidatesFor(si).length), 1);
  const MAX_COMBOS = 3000;

  // Rule 2: distinct tracks for distinct numbered platforms (one station at a time).
  const sharedOk = new Set<string>();
  for (let iter = 0; iter < 80; iter++) {
    const byTrack = new Map<string, number[]>();
    for (const si of numbered) {
      if (sharedOk.has(stationOf(si))) continue;
      const k = `${stationOf(si)}|${candidatesFor(si)[pick(sol, pins, si)]!.seg}`;
      (byTrack.get(k) ?? byTrack.set(k, []).get(k)!).push(si);
    }
    const conflict = [...byTrack.values()].find((v) =>
      v.some((a, i) => v.some((b, j) => j > i && !mayShare(a, b))),
    );
    if (!conflict) break;
    const station = stationOf(conflict[0]!);
    const group = numbered.filter((si) => stationOf(si) === station);
    let best = bestPinning(pins, group, (a, b) => !mayShare(a, b));
    const breaksMore = (t: number | undefined) =>
      t === undefined
      || Math.floor(t / BREAK_COST) > Math.floor(sol.total / BREAK_COST);
    if (breaksMore(best?.total)) {
      // Earlier decisions at neighbouring stations may be what blocks this one: re-solve jointly.
      const near = numbered.filter(
        (si) => neighbours.get(station)?.has(stationOf(si)) && pins.has(si),
      );
      const joint = [...group, ...near];
      if (near.length && comboCount(joint) <= MAX_COMBOS) {
        const freed = new Map([...pins].filter(([si]) => !near.includes(si)));
        const j = bestPinning(freed, joint, (a, b) => !mayShare(a, b));
        if (j && (!best || j.total < best.total)) {
          best = j;
          for (const si of near) pins.delete(si);
        }
      }
    }
    // If keeping them apart breaks the timetable, they really share a track (e.g. a track with
    // platforms on both sides).
    if (!best || breaksMore(best.total)) {
      sharedOk.add(station);
      continue;
    }
    for (const [k, v] of best.pins) pins.set(k, v);
    sol = evaluate(pins);
  }

  // Rule 3: turnbacks at termini — re-choose the station's terminal platforms jointly.
  const triedStations = new Set<string>();
  const failingStation = (f: string) => {
    const e = sol.ends.find(
      (x) => f === `${plan.stops[x.last.si]!.name} (${x.route})`,
    );
    return e ? stationOf(e.last.si) : undefined;
  };
  for (let iter = 0; iter < 40; iter++) {
    // First failing terminus not yet optimised; the rest are real infrastructure gaps (reported).
    const station = [...sol.turnbackFailures]
      .map(failingStation)
      .find((st) => st && !triedStations.has(st));
    if (!station) break;
    triedStations.add(station);
    const group = railStops.filter(
      (si) => stationOf(si) === station && (only(si, "arr") || only(si, "dep")),
    );
    if (!group.length || comboCount(group) > MAX_COMBOS) continue;
    const saved = new Map([...pins].filter(([si]) => !group.includes(si)));
    const best = bestPinning(
      saved,
      group,
      (a, b) =>
        !mayShare(a, b)
        && Boolean(plan.stops[a]!.platform && plan.stops[b]!.platform),
    );
    if (best && best.total < sol.total) {
      for (const si of group) pins.delete(si);
      for (const [k, v] of best.pins) pins.set(k, v);
      sol = evaluate(pins);
    }
  }

  // --- results ---
  const assignments = new Map<string, PlatformAssignment>();
  const unmapped: string[] = [];
  for (const si of railStops) {
    const s: PlanStop = plan.stops[si]!;
    const cands = candidatesFor(si);
    if (!cands.length) {
      unmapped.push(s.name);
      continue;
    }
    const v = sol.votes.get(si);
    const chosen = pick(sol, pins, si);
    const total = v?.reduce((a, b) => a + b, 0) ?? 0;
    const method: PlatformAssignment["method"] =
      overrideByName.has(s.name) ? "override"
      : v ? "consistent"
      : "nearest";
    const c = cands[chosen]!;
    assignments.set(s.id, {
      stopId: s.id,
      name: s.name,
      pos: { seg: c.seg, offset: c.offset },
      dist: c.dist,
      method,
      agreement: total ? v![chosen]! / total : 0,
    });
  }
  const patternPositions = new Map<number, Map<number, TrackPos>>();
  for (const [pid, m] of pinned)
    patternPositions.set(
      pid,
      new Map([...m].map(([i, c]) => [i, { seg: c.seg, offset: c.offset }])),
    );
  return {
    assignments,
    unmapped,
    breaks: [...sol.breaks],
    turnbackFailures: [...sol.turnbackFailures],
    patternPositions,
  };
}
