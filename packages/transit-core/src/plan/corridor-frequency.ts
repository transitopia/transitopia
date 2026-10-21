// What the map's bus corridors and stop ticks are coloured by (packages/transit-core/DESIGN.md#bus-corridors):
// each route's own frequency, and where routes share a stretch (the stop cards' rule,
// schedule/departures.ts → sharedRuns), the frequency of their merged departures. A corridor shows
// the best of these: what a rider travelling along it can count on.
//
// Corridors and stops with the same services are one "combo", so they always get the same colour;
// the combos are worked out once per plan, and only their frequencies per time window.

import { indexCalendar } from "../gtfs/calendar.ts";
import { localProjector } from "../geo.ts";
import { onwardStops, sharedRuns } from "../schedule/departures.ts";
import {
  countIn,
  departuresAround,
  regularWeekdays,
  bestHourly,
  hourlyWaits,
  weekdayCount,
  weekdayFigure,
  worstWait,
  type ServicesOn,
  type Starts,
} from "../schedule/frequency.ts";
import type { ServiceDate } from "../time.ts";
import {
  patternStarts,
  STOP_NO_PICKUP,
  type PlanCorridor,
  type PlanFrequencyTable,
  type ServicePlan,
} from "./types.ts";

/**
 * A route runs at its whole frequency (its better direction's, as on its route card) wherever at
 * least this share of its trips in that direction pass; elsewhere (a short-turn's far end, a branch, limited service such as the 99 east of
 * Commercial–Broadway) at the frequency of the trips that do. So the odd variant trip doesn't change a
 * route's colour from block to block. A presentation choice (guess).
 */
const WHOLE_ROUTE_SHARE = 0.75;
/**
 * A corridor this short (m) is never drawn busier than the busiest corridor it joins: at a
 * junction, a crossing or turning route can share a few metres of another's street.
 */
const SHORT_M = 50;
/**
 * Routes sharing a stretch are merged at the times their trips pass a point on it, each pattern's
 * trip start plus its typical time to there, kept to this resolution (s) so the combos along a
 * stretch stay few.
 */
const OFFSET_STEP_S = 60;

export type FrequencyCombo = PlanFrequencyTable["combos"][number];
/** Worst waits (s): a window's (one), or each weekday hour's (`hourlyWaits`); undefined when nothing runs. */
type Waits = Float64Array | undefined;
export type ComboUnit = FrequencyCombo["units"][number];

/** The window frequencies are worked out for: the `seconds` from `from` on a date, or regular weekdays (`regularWeekdays`). */
export type FrequencyQuery =
  { date: ServiceDate; from: number; seconds: number } | "weekdays";

/** What `CorridorFrequency.frequencies` works out. */
export interface ComboFrequencies {
  /** Per combo: the worst wait (minutes) of the best of its units and bundles; Infinity when none runs. */
  best: Float32Array;
  /**
   * Per combo, per unit: its trips in the window, at its route's whole count where
   * WHOLE_ROUTE_SHARE of them pass.
   */
  trips: Float32Array[];
  /** Per route shown: its worst wait (minutes) in its better direction, as on its route card. */
  routeWaits: Map<string, number>;
}

export class CorridorFrequency {
  private readonly plan: ServicePlan;
  private readonly servicesOn: ServicesOn;
  /** Per pattern, per service: its trips' start times. */
  private readonly starts: Record<string, number[]>[];
  private weekdayDates: ServiceDate[] | undefined;
  /** Weekday figures by sources, which don't change with the shown date. */
  private readonly weekdayMemo = new Map<string, Waits>();
  /** A route in one direction: its key and every pattern of it. */
  readonly routeDirs: { route: string; patterns: number[] }[] = [];
  private readonly routeDirOf: number[];
  readonly combos: FrequencyCombo[] = [];
  private readonly comboIds = new Map<string, number>();
  /** Per pattern: the stretches it shares with other routes, [from, to] (m along it) and the routes (routeDir indices). */
  private readonly sharedAlong: [number, number, number[]][][];
  /** Per stop: the route sets that share a stretch from it. */
  private readonly sharedFrom = new Map<number, number[][]>();
  /** Per pattern, its trips' typical departure from each stop (s from the start). */
  private typical: number[][] | undefined;

  /** Each stop's combo, from a published plan's table (`ServicePlan.frequency`). */
  private readonly stopCombo: readonly number[] | undefined;

  /**
   * From the plan's frequency table where it has one (published plans: worked out once, when
   * published), else from its patterns and trips.
   */
  constructor(plan: ServicePlan) {
    this.plan = plan;
    this.servicesOn = indexCalendar(plan.calendar);
    this.starts = patternStarts(plan);
    const table = plan.frequency;
    if (table) {
      this.routeDirs.push(...table.routeDirs);
      this.routeDirOf = plan.patterns.map(() => -1);
      table.routeDirs.forEach((rd, i) =>
        rd.patterns.forEach((p) => (this.routeDirOf[p] = i)),
      );
      this.combos.push(...table.combos);
      this.sharedAlong = [];
      this.stopCombo = table.stopCombo;
      return;
    }
    this.stopCombo = undefined;
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

  /**
   * Per pattern, its trips' median departure from each stop (s after the start), for the times
   * they pass a point (`timeAlong`). Zero where a pattern's trips have no stop times.
   */
  private typicalTimes(): number[][] {
    if (this.typical) return this.typical;
    const byPattern = this.plan.patterns.map((p) =>
      p.stops.map((): number[] => []),
    );
    for (const t of this.plan.trips) {
      const times = t.dep ?? t.arr;
      const lists = byPattern[t.pattern]!;
      for (let i = 0; i < lists.length && i < times.length; i++)
        lists[i]!.push(times[i]!);
    }
    this.typical = byPattern.map((lists) =>
      lists.map((l) => {
        if (!l.length) return 0;
        l.sort((a, b) => a - b);
        return l[l.length >> 1]!;
      }),
    );
    return this.typical;
  }

  /** When a pattern's trips typically pass `m` metres along it (s after the start). */
  private timeAlong(pattern: number, m: number): number {
    const { dist } = this.plan.patterns[pattern]!;
    const times = this.typicalTimes()[pattern]!;
    if (!dist.length) return 0;
    let i = 0;
    while (i + 1 < dist.length && dist[i + 1]! <= m) i++;
    if (i + 1 >= dist.length) return times[i]!;
    const f = (m - dist[i]!) / (dist[i + 1]! - dist[i]! || 1);
    return times[i]! + Math.max(0, f) * (times[i + 1]! - times[i]!);
  }

  /**
   * The combo for these patterns (each with its time to the place, s after its start) and route
   * sets (each kept where two or more of its routes are here). Units in a bundle keep their
   * patterns' times there, relative to the earliest (OFFSET_STEP_S), for merging their departures.
   */
  private comboOf(
    patterns: Iterable<[pattern: number, at: number]>,
    sharedSets: Iterable<number[]>,
  ): number {
    const byRd = new Map<number, Map<number, number>>();
    for (const [p, at] of patterns) {
      const rd = this.routeDirOf[p]!;
      let l = byRd.get(rd);
      if (!l) byRd.set(rd, (l = new Map()));
      if (!l.has(p)) l.set(p, at);
    }
    const sorted = [...byRd]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([routeDir, ps]) =>
          [routeDir, [...ps].sort((a, b) => a[0] - b[0])] as const,
      );
    const index = new Map(sorted.map(([rd], i) => [rd, i]));
    const bundles = new Map<string, number[]>();
    for (const set of sharedSets) {
      const b = set.flatMap((rd) => index.get(rd) ?? []);
      if (b.length >= 2) bundles.set(b.join(","), b);
    }
    const bundled = new Set([...bundles.values()].flat());
    let earliest = Infinity;
    sorted.forEach(([, ps], i) => {
      if (bundled.has(i))
        for (const [, at] of ps) earliest = Math.min(earliest, at);
    });
    const units: ComboUnit[] = sorted.map(([routeDir, ps], i) => ({
      routeDir,
      patterns: ps.map(([p]) => p),
      ...(bundled.has(i) ?
        {
          offsets: ps.map(
            ([, at]) =>
              Math.round((at - earliest) / OFFSET_STEP_S) * OFFSET_STEP_S,
          ),
        }
      : {}),
    }));
    const combo: FrequencyCombo = {
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
   * Each corridor's combo: its patterns (with when each passes its middle), and the shared
   * stretches that cover its middle along each pattern there.
   */
  combosOfCorridors(corridors: readonly PlanCorridor[]): Int32Array {
    return Int32Array.from(corridors, (c) => {
      if (c.combo !== undefined) return c.combo;
      if (!c.refs) throw new Error("A corridor has neither refs nor a combo");
      const half = lengthM(c) / 2;
      const sets: number[][] = [];
      for (const [p, , along] of c.refs) {
        const mid = along + half;
        for (const [from, to, rds] of this.sharedAlong[p] ?? [])
          if (mid >= from && mid <= to) sets.push(rds);
      }
      const shared = new Set(sets.flat());
      return this.comboOf(
        c.refs.map(([p, , along]): [number, number] => [
          p,
          shared.has(this.routeDirOf[p]!) ? this.timeAlong(p, along + half) : 0,
        ]),
        sets,
      );
    });
  }

  /**
   * Each stop's combo: the routes leaving it and the stretches they share from it (what its card
   * lists). A stop nothing leaves from (a last stop) gets the routes arriving.
   */
  combosOfStops(stops: readonly number[]): Int32Array {
    const table = this.stopCombo;
    if (table) return Int32Array.from(stops, (s) => table[s]!);
    // Per stop: pattern → its index there.
    const leaving = new Map<number, Map<number, number>>();
    const arriving = new Map<number, Map<number, number>>();
    for (const p of this.plan.patterns)
      p.stops.forEach((s, i) => {
        const to =
          (
            i < p.stops.length - 1
            && ((p.access?.[i] ?? 0) & STOP_NO_PICKUP) === 0
          ) ?
            leaving
          : arriving;
        let at = to.get(s);
        if (!at) to.set(s, (at = new Map()));
        if (!at.has(p.id)) at.set(p.id, i);
      });
    return Int32Array.from(stops, (s) => {
      const sets = this.sharedFrom.get(s) ?? [];
      const shared = new Set(sets.flat());
      const at = leaving.get(s) ?? arriving.get(s) ?? new Map<number, number>();
      return this.comboOf(
        [...at].map(([p, i]): [number, number] => [
          p,
          shared.has(this.routeDirOf[p]!) ?
            (this.typicalTimes()[p]![i] ?? 0)
          : 0,
        ]),
        sets,
      );
    });
  }

  /** Every plan stop's combo (`combosOfStops`), for the plan's frequency table. */
  stopCombos(): number[] {
    return [...this.combosOfStops(this.plan.stops.map((_, i) => i))];
  }

  /**
   * The combos found so far, each with its weekday figure with every route shown (`weekday`), for the
   * plan's frequency table.
   */
  combosWithWeekday(): FrequencyCombo[] {
    const { best } = this.frequencies("weekdays", () => true);
    return this.combos.map((c, i) => {
      const { weekday: _w, ...rest } = c;
      const w = best[i]!;
      return Number.isFinite(w) ?
          { ...rest, weekday: Math.round(w * 10) / 10 }
        : rest;
    });
  }

  /**
   * The worst wait (minutes) of departures from `sources` in a window, or for "weekdays" their
   * weekday figure; Infinity when none run. For what the corridors don't combine on their own: a
   * combined route (schedule/shared-segment.ts).
   */
  waitOf(query: FrequencyQuery, sources: readonly Starts[]): number {
    if (query === "weekdays")
      return (
        weekdayFigure(hourlyWaits(this.servicesOn, this.weekdays(), sources))
        ?? Infinity
      );
    const { date, from, seconds } = query;
    const w = worstWait(
      departuresAround(this.servicesOn, sources, date, from, from + seconds),
      from,
      from + seconds,
    );
    return w === undefined ? Infinity : w / 60;
  }

  /** The regular weekdays (`regularWeekdays`) the weekday figures are for. */
  private weekdays(): ServiceDate[] {
    return (this.weekdayDates ??= regularWeekdays(
      this.servicesOn,
      this.plan.feedStart,
      this.plan.feedEnd,
    ));
  }

  /**
   * Every combo's frequency in a window: each unit at its route's whole frequency where
   * WHOLE_ROUTE_SHARE of its trips pass, else its own trips'; each bundle by its units' merged
   * departures; the best (shortest worst wait) of those, for weekdays hour by hour before the
   * median (`weekdayWait`). Routes `include` leaves out count for nothing.
   */
  frequencies(
    query: FrequencyQuery,
    include: (route: string) => boolean,
  ): ComboFrequencies {
    const { servicesOn } = this;
    const days = query === "weekdays" ? this.weekdays() : undefined;
    const now =
      days ? undefined : (query as Exclude<FrequencyQuery, "weekdays">);
    const memo = days ? this.weekdayMemo : new Map<string, Waits>();
    const sourcesOf = (patterns: readonly number[], offsets?: number[]) =>
      patterns.map((p, i): Starts => ({
        byService: this.starts[p]!,
        offset: offsets?.[i] ?? 0,
      }));
    // Worst waits by sources: the window's, or each weekday hour's (`hourlyWaits`), in seconds.
    const waitsOf = (key: string, sources: () => Starts[]): Waits => {
      if (memo.has(key)) return memo.get(key);
      let w: Waits;
      if (days) w = hourlyWaits(servicesOn, days, sources());
      else {
        const { date, from, seconds } = now!;
        const s = worstWait(
          departuresAround(servicesOn, sources(), date, from, from + seconds),
          from,
          from + seconds,
        );
        w = s === undefined ? undefined : Float64Array.of(s);
      }
      memo.set(key, w);
      return w;
    };
    /** The figure (minutes) for worst waits; Infinity when nothing runs. */
    const figure = (w: Waits): number =>
      (days ? weekdayFigure(w) : w && w[0]! / 60) ?? Infinity;
    const counts = new Map<string, number>();
    const countOf = (key: string, sources: () => Starts[]): number => {
      let n = counts.get(key);
      if (n !== undefined) return n;
      if (days) n = weekdayCount(servicesOn, days, sources());
      else {
        const { date, from, seconds } = now!;
        n = countIn(servicesOn, sources(), date, from, from + seconds);
      }
      counts.set(key, n);
      return n;
    };
    const patternsKey = (ps: readonly number[]) => ps.join(",");
    const rdWaits = (i: number): Waits => {
      const rd = this.routeDirs[i]!;
      return waitsOf(patternsKey(rd.patterns), () => sourcesOf(rd.patterns));
    };

    const shown = this.routeDirs.map((rd) => include(rd.route));
    const whole = this.routeDirs.map((rd, i) =>
      shown[i] ?
        countOf(patternsKey(rd.patterns), () => sourcesOf(rd.patterns))
      : 0,
    );
    const busier = new Map<string, number>();
    const dirsOf = new Map<string, number[]>();
    this.routeDirs.forEach((rd, i) => {
      if (!shown[i]) return;
      busier.set(rd.route, Math.max(busier.get(rd.route) ?? 0, whole[i]!));
      dirsOf.set(rd.route, [...(dirsOf.get(rd.route) ?? []), i]);
    });
    // A route's worst waits: its better direction's, hour by hour.
    const routeMemo = new Map<string, Waits>();
    const routeWaitsOf = (route: string): Waits => {
      if (!routeMemo.has(route))
        routeMemo.set(route, bestHourly(dirsOf.get(route)!.map(rdWaits)));
      return routeMemo.get(route);
    };
    const stored = new Map(this.plan.routes.map((r) => [r.key, r.weekdayWait]));
    const routeWaits = new Map<string, number>();
    for (const route of dirsOf.keys())
      routeWaits.set(
        route,
        (days && stored.get(route)) || figure(routeWaitsOf(route)),
      );
    const everyone = shown.every(Boolean);
    const best = new Float32Array(this.combos.length);
    const trips = this.combos.map((c, i) => {
      const options: Waits[] = [];
      const n = Float32Array.from(c.units, (u) => {
        if (!shown[u.routeDir]) return 0;
        const key = patternsKey(u.patterns);
        const sources = () => sourcesOf(u.patterns);
        const here = countOf(key, sources);
        const route = this.routeDirs[u.routeDir]!.route;
        if (here >= WHOLE_ROUTE_SHARE * whole[u.routeDir]!) {
          options.push(routeWaitsOf(route));
          return busier.get(route)!;
        }
        if (here) options.push(waitsOf(key, sources));
        return here;
      });
      if (days && everyone && c.weekday !== undefined) {
        best[i] = c.weekday;
        return n;
      }
      for (const bundle of c.bundles) {
        const members = bundle.filter((u) => n[u]! > 0);
        if (members.length < 2) continue;
        const parts = members.flatMap((u) => {
          const unit = c.units[u]!;
          return unit.patterns.map((p, j) => [p, unit.offsets?.[j] ?? 0]);
        });
        options.push(
          waitsOf(parts.map(([p, o]) => `${p}@${o}`).join(","), () =>
            parts.map(([p, o]) => ({
              byService: this.starts[p!]!,
              offset: o!,
            })),
          ),
        );
      }
      best[i] = figure(bestHourly(options));
      return n;
    });
    return { best, trips, routeWaits };
  }
}

/**
 * For each corridor under SHORT_M, the corridors meeting it at either end, to cap its frequency at
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

/** Per-corridor worst waits with each short corridor's no better than its best neighbour's. */
export function capShort(
  waits: Float32Array,
  neighbours: readonly [number, number[]][],
): Float32Array {
  const out = waits.slice();
  for (const [i, nb] of neighbours)
    out[i] = Math.max(waits[i]!, Math.min(...nb.map((j) => waits[j]!)));
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

/**
 * A route with its own colour is drawn in it only where it runs at least this share as often as on
 * its busiest stretch; elsewhere (limited service, e.g. the 99 east of Commercial–Broadway) its buses
 * count towards the frequency colour like any other (plan/coverage.ts).
 */
export const LIMITED_SHARE = 0.25;

/**
 * What corridors (or stops) show (packages/transit-map/README.md#bus-corridors): per feature, the worst
 * wait its colour tier is for, and the route with its own colour drawn along it, if any. The map's
 * engine works this out for the time shown, the overview tiles for regular weekdays.
 */
export interface CorridorStyle {
  /** Per feature: the worst wait (minutes), a short corridor's no better than its best neighbour's. */
  waits: Float32Array;
  /** Feature index → brand (an index into the plan's routes with their own colour). */
  brands: Map<number, number>;
}

/**
 * @param combo Per feature, its combo.
 * @param short Short corridors and their neighbours (`shortCorridorNeighbours`; none for stops).
 * @param brandOf Per routeDir of `cf`, its brand, or -1 for a route without its own colour.
 * @param ratesAt Per feature, the frequencies it shows (a focused route's own, on its corridors).
 * @param stops Features are stops: one shows a brand only where only such routes serve it.
 */
export function corridorStyle(
  cf: CorridorFrequency,
  combo: Int32Array,
  short: readonly [number, number[]][],
  brandOf: readonly number[],
  ratesAt: (i: number) => ComboFrequencies,
  stops = false,
): CorridorStyle {
  const waits = capShort(
    Float32Array.from(combo, (c, i) => ratesAt(i).best[c]!),
    short,
  );
  // Per combo and frequencies: [brand, its trips] of each route with its own colour there (the
  // busier direction).
  const perCombo = new Map<
    ComboFrequencies,
    Map<number, Map<number, number>>
  >();
  const ownOf = (c: number, i: number) => {
    const rates = ratesAt(i);
    let cache = perCombo.get(rates);
    if (!cache) perCombo.set(rates, (cache = new Map()));
    let own = cache.get(c);
    if (own) return own;
    own = new Map();
    let others = false;
    cf.combos[c]!.units.forEach((u, k) => {
      const b = brandOf[u.routeDir]!;
      if (b < 0) others = true;
      else own!.set(b, Math.max(own!.get(b) ?? 0, rates.trips[c]![k]!));
    });
    if (stops && others) own.clear();
    cache.set(c, own);
    return own;
  };
  const perFeature = Array.from(combo, ownOf);
  const busiest = new Map<number, number>();
  for (const own of perFeature)
    for (const [b, n] of own) busiest.set(b, Math.max(busiest.get(b) ?? 0, n));
  const brands = new Map<number, number>();
  perFeature.forEach((own, i) => {
    let top: [number, number] | undefined;
    for (const [b, n] of own)
      if (n > 0 && n >= LIMITED_SHARE * busiest.get(b)! && n > (top?.[1] ?? 0))
        top = [b, n];
    if (top) brands.set(i, top[0]);
  });
  return { waits, brands };
}
