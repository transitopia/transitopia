// What the map's bus corridors and stop ticks are coloured by (packages/transit-core/DESIGN.md#bus-corridors):
// each route's own frequency, and where routes share a stretch (the stop cards' rule,
// schedule/departures.ts → sharedRuns), their combined frequency. A corridor shows the best
// of these: what a rider travelling along it can count on.
//
// Corridors and stops with the same services are one "combo", so they always get the same colour;
// the combos are worked out once per plan, and only their rates per time window.

import { localProjector } from "../geo.ts";
import { onwardStops, sharedRuns } from "../schedule/departures.ts";
import {
  STOP_NO_PICKUP,
  type PlanCorridor,
  type ServicePlan,
} from "./types.ts";

/**
 * A route runs at its whole frequency (its busier direction's, as on its route card) wherever at
 * least this share of its trips in that direction pass; elsewhere (a short-turn's far end, a branch, limited service such as the 99 east of
 * Commercial–Broadway) at the rate of the trips that do. So the odd variant trip doesn't change a
 * route's colour from block to block. A presentation choice (guess).
 */
const WHOLE_ROUTE_SHARE = 0.75;
/**
 * A corridor this short (m) is never drawn busier than the busiest corridor it joins: at a
 * junction, a crossing or turning route can share a few metres of another's street.
 */
const SHORT_M = 50;

/** One route's patterns in one direction, as found on a corridor or at a stop. */
export interface ComboUnit {
  /** Index into `CorridorFrequency.routeDirs`. */
  routeDir: number;
  patterns: number[];
}

export interface FrequencyCombo {
  units: ComboUnit[];
  /** Units (indices into `units`) that share a stretch here, two or more each. */
  bundles: number[][];
}

/** A combo's rates: its best (buses an hour) and each unit's own. */
export interface ComboRates {
  best: Float32Array;
  units: Float32Array[];
}

export class CorridorFrequency {
  private readonly plan: ServicePlan;
  /** A route in one direction: its key and every pattern of it. */
  readonly routeDirs: { route: string; patterns: number[] }[] = [];
  private readonly routeDirOf: number[];
  readonly combos: FrequencyCombo[] = [];
  private readonly comboIds = new Map<string, number>();
  /** Per pattern: the stretches it shares with other routes, [from, to] (m along it) and the routes (routeDir indices). */
  private readonly sharedAlong: [number, number, number[]][][];
  /** Per stop: the route sets that share a stretch from it. */
  private readonly sharedFrom = new Map<number, number[][]>();

  constructor(plan: ServicePlan) {
    this.plan = plan;
    const rdIds = new Map<string, number>();
    this.routeDirOf = plan.patterns.map((p) => {
      const key = `${p.route}|${p.direction}`;
      let id = rdIds.get(key);
      if (id === undefined) {
        rdIds.set(key, (id = this.routeDirs.length));
        this.routeDirs.push({ route: p.route, patterns: [] });
      }
      this.routeDirs[id]!.patterns.push(p.id);
      return id;
    });
    this.sharedAlong = plan.patterns.map(() => []);
    this.findShared();
  }

  /**
   * At each stop, the groups a stop card would list (route + destination; each by the pattern most
   * of its trips there follow) and the stretches they share (`sharedRuns`), as route sets from the
   * stop and as ranges along each member's pattern.
   */
  private findShared(): void {
    const { plan } = this;
    const tripsBy = new Map<string, number>();
    for (const t of plan.trips) {
      const k = `${t.pattern}|${t.headsign}`;
      tripsBy.set(k, (tripsBy.get(k) ?? 0) + 1);
    }
    // Per stop: group (route|headsign) → [pattern, index, trips].
    const groups = new Map<number, Map<string, [number, number, number]>>();
    for (const [k, n] of tripsBy) {
      const bar = k.indexOf("|");
      const p = plan.patterns[Number(k.slice(0, bar))]!;
      const g = `${p.route}|${k.slice(bar + 1)}`;
      for (let i = 0; i < p.stops.length - 1; i++) {
        if (((p.access?.[i] ?? 0) & STOP_NO_PICKUP) !== 0) continue;
        let at = groups.get(p.stops[i]!);
        if (!at) groups.set(p.stops[i]!, (at = new Map()));
        const cur = at.get(g);
        if (!cur || n > cur[2]) at.set(g, [p.id, i, n]);
      }
    }
    for (const [stop, at] of groups) {
      const reps = [...at.values()];
      if (reps.length < 2) continue;
      const runs = sharedRuns(reps.map(([p, i]) => onwardStops(plan, p, i)));
      for (const { members, stops } of runs) {
        const rds = [
          ...new Set(members.map((m) => this.routeDirOf[reps[m]![0]]!)),
        ].sort((a, b) => a - b);
        if (rds.length < 2) continue;
        let from = this.sharedFrom.get(stop);
        if (!from) this.sharedFrom.set(stop, (from = []));
        from.push(rds);
        for (const m of members) {
          const [p, i] = reps[m]!;
          const dist = plan.patterns[p]!.dist;
          this.sharedAlong[p]!.push([dist[i]!, dist[i + stops]!, rds]);
        }
      }
    }
  }

  /** The combo for these units and route sets (each kept where two or more of its routes are here). */
  private comboOf(
    patterns: Iterable<number>,
    sharedSets: Iterable<number[]>,
  ): number {
    const byRd = new Map<number, number[]>();
    for (const p of patterns) {
      const rd = this.routeDirOf[p]!;
      const l = byRd.get(rd);
      if (l) {
        if (!l.includes(p)) l.push(p);
      } else byRd.set(rd, [p]);
    }
    const units = [...byRd]
      .sort((a, b) => a[0] - b[0])
      .map(([routeDir, ps]) => ({
        routeDir,
        patterns: ps.sort((a, b) => a - b),
      }));
    const index = new Map(units.map((u, i) => [u.routeDir, i]));
    const bundles = new Map<string, number[]>();
    for (const set of sharedSets) {
      const b = set.flatMap((rd) => index.get(rd) ?? []);
      if (b.length >= 2) bundles.set(b.join(","), b);
    }
    const combo = {
      units,
      bundles: [...bundles.keys()].sort().map((k) => bundles.get(k)!),
    };
    const key = JSON.stringify(combo);
    let id = this.comboIds.get(key);
    if (id === undefined) {
      this.comboIds.set(key, (id = this.combos.length));
      this.combos.push(combo);
    }
    return id;
  }

  /**
   * Each corridor's combo: its patterns, and the shared stretches that cover its middle along
   * each pattern there.
   */
  combosOfCorridors(corridors: readonly PlanCorridor[]): Int32Array {
    return Int32Array.from(corridors, (c) => {
      const half = lengthM(c) / 2;
      const sets: number[][] = [];
      for (const [p, , along] of c.refs) {
        const mid = along + half;
        for (const [from, to, rds] of this.sharedAlong[p] ?? [])
          if (mid >= from && mid <= to) sets.push(rds);
      }
      return this.comboOf(
        c.refs.map(([p]) => p),
        sets,
      );
    });
  }

  /**
   * Each stop's combo: the routes leaving it and the stretches they share from it (what its card
   * lists). A stop nothing leaves from (a last stop) gets the routes arriving.
   */
  combosOfStops(stops: readonly number[]): Int32Array {
    const leaving = new Map<number, Set<number>>();
    const arriving = new Map<number, Set<number>>();
    for (const p of this.plan.patterns)
      p.stops.forEach((s, i) => {
        const to =
          (
            i < p.stops.length - 1
            && ((p.access?.[i] ?? 0) & STOP_NO_PICKUP) === 0
          ) ?
            leaving
          : arriving;
        let set = to.get(s);
        if (!set) to.set(s, (set = new Set()));
        set.add(p.id);
      });
    return Int32Array.from(stops, (s) =>
      this.comboOf(
        leaving.get(s) ?? arriving.get(s) ?? [],
        this.sharedFrom.get(s) ?? [],
      ),
    );
  }

  /**
   * Every combo's rates for patterns running `perHour` (BusFrequency.perHour): each unit at its
   * route's whole frequency where WHOLE_ROUTE_SHARE of its trips pass, its bundles summed, the best
   * of those. Routes `include` leaves out count for nothing.
   */
  rates(
    perHour: Float64Array,
    include: (route: string) => boolean,
  ): ComboRates {
    const shown = this.routeDirs.map((rd) => include(rd.route));
    const whole = this.routeDirs.map((rd, i) =>
      shown[i] ? rd.patterns.reduce((n, p) => n + perHour[p]!, 0) : 0,
    );
    const busier = new Map<string, number>();
    this.routeDirs.forEach((rd, i) =>
      busier.set(rd.route, Math.max(busier.get(rd.route) ?? 0, whole[i]!)),
    );
    const best = new Float32Array(this.combos.length);
    const units = this.combos.map((c, i) => {
      const r = Float32Array.from(c.units, (u) => {
        if (!shown[u.routeDir]) return 0;
        const here = u.patterns.reduce((n, p) => n + perHour[p]!, 0);
        return here >= WHOLE_ROUTE_SHARE * whole[u.routeDir]! ?
            busier.get(this.routeDirs[u.routeDir]!.route)!
          : here;
      });
      let b = Math.max(0, ...r);
      for (const bundle of c.bundles)
        b = Math.max(
          b,
          bundle.reduce((n, u) => n + r[u]!, 0),
        );
      best[i] = b;
      return r;
    });
    return { best, units };
  }
}

/**
 * For each corridor under SHORT_M, the corridors meeting it at either end, to cap its rate at
 * theirs (`capShort`).
 */
export function shortCorridorNeighbours(
  corridors: readonly PlanCorridor[],
): [number, number[]][] {
  const key = (p: readonly number[]) => `${p[0]},${p[1]}`;
  const ends = (c: PlanCorridor) => [c.coords[0]!, c.coords.at(-1)!];
  const at = new Map<string, number[]>();
  corridors.forEach((c, i) => {
    for (const p of ends(c)) {
      const k = key(p);
      at.set(k, [...(at.get(k) ?? []), i]);
    }
  });
  return corridors.flatMap((c, i): [number, number[]][] => {
    if (c.coords.length < 2 || lengthM(c) >= SHORT_M) return [];
    const nb = [...new Set(ends(c).flatMap((p) => at.get(key(p))!))].filter(
      (j) => j !== i,
    );
    return nb.length ? [[i, nb]] : [];
  });
}

/** Per-corridor rates with each short corridor capped at its busiest neighbour's. */
export function capShort(
  rates: Float32Array,
  neighbours: readonly [number, number[]][],
): Float32Array {
  const out = rates.slice();
  for (const [i, nb] of neighbours)
    out[i] = Math.min(rates[i]!, Math.max(...nb.map((j) => rates[j]!)));
  return out;
}

/** A corridor's length (m). */
function lengthM(c: PlanCorridor): number {
  if (c.coords.length < 2) return 0;
  const { toXY } = localProjector(c.coords[0]![1]);
  let m = 0;
  for (let i = 1; i < c.coords.length; i++) {
    const [ax, ay] = toXY(c.coords[i - 1]!);
    const [bx, by] = toXY(c.coords[i]!);
    m += Math.hypot(bx - ax, by - ay);
  }
  return m;
}
